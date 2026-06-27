const fs = require("fs");
const path = require("path");
const discord = require("discord.js");
const Client = discord.Client ?? discord.default?.Client;
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} = discord;

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
const TABLES_FILE = path.join(__dirname, "..", "timer-tables.json");
const TABLE_BACKUP_DIR = path.join(__dirname, "..", "backups", "tables");

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
      sessionStartedAtMs: null,
      timerName: null,
      lastStoppedTimerRecord: null,
    };
  }

  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const state = JSON.parse(raw);
    return {
      running: Boolean(state.running),
      startedAtMs: typeof state.startedAtMs === "number" ? state.startedAtMs : null,
      accumulatedMs: Number.isFinite(state.accumulatedMs) ? state.accumulatedMs : 0,
      sessionStartedAtMs: typeof state.sessionStartedAtMs === "number" ? state.sessionStartedAtMs : null,
      timerName: typeof state.timerName === "string" && state.timerName.trim() ? state.timerName.trim() : null,
      lastStoppedTimerRecord: state.lastStoppedTimerRecord && typeof state.lastStoppedTimerRecord === "object"
        ? {
            timerName: sanitizeTimerName(state.lastStoppedTimerRecord.timerName) || "Timer",
            startedAtMs: Number.isFinite(state.lastStoppedTimerRecord.startedAtMs) ? state.lastStoppedTimerRecord.startedAtMs : null,
            stoppedAtMs: Number.isFinite(state.lastStoppedTimerRecord.stoppedAtMs) ? state.lastStoppedTimerRecord.stoppedAtMs : null,
            durationMs: Number.isFinite(state.lastStoppedTimerRecord.durationMs) ? state.lastStoppedTimerRecord.durationMs : 0,
          }
        : null,
    };
  } catch {
    return {
      running: false,
      startedAtMs: null,
      accumulatedMs: 0,
      sessionStartedAtMs: null,
      timerName: null,
      lastStoppedTimerRecord: null,
    };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadTables() {
  if (!fs.existsSync(TABLES_FILE)) {
    return { tables: {} };
  }

  try {
    const raw = fs.readFileSync(TABLES_FILE, "utf8");
    const data = JSON.parse(raw);
    const sourceTables = data && typeof data.tables === "object" && data.tables !== null ? data.tables : {};
    const tables = {};

    for (const [name, table] of Object.entries(sourceTables)) {
      const normalizedName = sanitizeTimerName(name);
      if (!normalizedName) {
        continue;
      }

      const timers = Array.isArray(table?.timers)
        ? table.timers
            .map((record) => ({
              timerName: sanitizeTimerName(record?.timerName) || "Timer",
              startedAtMs: Number.isFinite(record?.startedAtMs) ? record.startedAtMs : null,
              stoppedAtMs: Number.isFinite(record?.stoppedAtMs) ? record.stoppedAtMs : null,
              durationMs: Number.isFinite(record?.durationMs) ? record.durationMs : 0,
            }))
            .filter((record) => record.startedAtMs !== null && record.stoppedAtMs !== null)
        : [];

      tables[normalizedName] = {
        name: normalizedName,
        createdAtMs: Number.isFinite(table?.createdAtMs) ? table.createdAtMs : Date.now(),
        timers,
      };
    }

    return { tables };
  } catch {
    return { tables: {} };
  }
}

function saveTables(tableStore) {
  fs.writeFileSync(TABLES_FILE, JSON.stringify(tableStore, null, 2));
}

function formatBackupDate(date) {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function backupTablesSnapshot() {
  try {
    if (!fs.existsSync(TABLES_FILE)) {
      return false;
    }

    fs.mkdirSync(TABLE_BACKUP_DIR, { recursive: true });

    const backupDate = formatBackupDate(new Date());
    const backupFile = path.join(TABLE_BACKUP_DIR, `timer-tables-${backupDate}.json`);
    const source = fs.readFileSync(TABLES_FILE, "utf8");
    fs.writeFileSync(backupFile, source);

    console.log(`Backed up tables to ${backupFile}`);
    return true;
  } catch (error) {
    console.error("Failed to back up tables:", error?.message || error);
    return false;
  }
}

function scheduleNightlyTableBackup() {
  const now = new Date();
  const nextRun = new Date(now);
  nextRun.setHours(24, 0, 0, 0);

  const delayMs = nextRun.getTime() - now.getTime();
  const timeout = setTimeout(() => {
    backupTablesSnapshot();

    const interval = setInterval(() => {
      backupTablesSnapshot();
    }, 24 * 60 * 60 * 1000);

    if (typeof interval.unref === "function") {
      interval.unref();
    }
  }, delayMs);

  if (typeof timeout.unref === "function") {
    timeout.unref();
  }
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

function getTableKey(input) {
  const value = sanitizeTimerName(input);
  return value ? value.toLowerCase() : null;
}

function getTimerDisplayName() {
  return state.timerName || "Timer";
}

function getSessionStartedAtMs(currentState) {
  if (typeof currentState.sessionStartedAtMs === "number") {
    return currentState.sessionStartedAtMs;
  }

  if (currentState.running && currentState.startedAtMs !== null) {
    return Math.max(0, currentState.startedAtMs - Math.max(0, currentState.accumulatedMs));
  }

  return null;
}

function buildTimerRecord(currentState) {
  const stoppedAtMs = Date.now();
  const startedAtMs = getSessionStartedAtMs(currentState) ?? stoppedAtMs;
  const durationMs = currentState.running ? getElapsedMs(currentState) : Math.max(0, currentState.accumulatedMs);

  return {
    timerName: getTimerDisplayName(),
    startedAtMs,
    stoppedAtMs,
    durationMs,
  };
}

function formatTimerRecord(record, index) {
  return `${String(index + 1).padStart(2, "0")}. ${record.timerName} | Started: ${formatDateDMY(record.startedAtMs)} | Stopped: ${formatDateDMY(record.stoppedAtMs)} | Duration: ${formatElapsed(record.durationMs)}`;
}

function chunkLines(lines, maxChars = 1800) {
  const chunks = [];
  let current = [];
  let currentLength = 0;

  for (const line of lines) {
    const lineLength = line.length + (current.length > 0 ? 1 : 0);
    if (currentLength + lineLength > maxChars && current.length > 0) {
      chunks.push(current.join("\n"));
      current = [line];
      currentLength = line.length;
    } else {
      current.push(line);
      currentLength += lineLength;
    }
  }

  if (current.length > 0) {
    chunks.push(current.join("\n"));
  }

  return chunks;
}

function stripOuterQuotes(input) {
  const value = String(input || "").trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function getTableStore() {
  return tables;
}

function getTableByName(tableName) {
  const key = getTableKey(tableName);
  if (!key) {
    return null;
  }

  const store = getTableStore().tables;
  if (store[key]) {
    return store[key];
  }

  for (const table of Object.values(store)) {
    if (typeof table?.name === "string" && table.name.toLowerCase() === key) {
      return table;
    }
  }

  return null;
}

function addRecordToTable(tableName, record) {
  const key = getTableKey(tableName);
  if (!key || !record) {
    return { ok: false, reason: "invalid" };
  }

  const store = getTableStore().tables;
  const table = getTableByName(tableName);
  if (!table) {
    return { ok: false, reason: "missing" };
  }

  table.timers.push({
    timerName: sanitizeTimerName(record.timerName) || "Timer",
    startedAtMs: Number.isFinite(record.startedAtMs) ? record.startedAtMs : Date.now(),
    stoppedAtMs: Number.isFinite(record.stoppedAtMs) ? record.stoppedAtMs : Date.now(),
    durationMs: Number.isFinite(record.durationMs) ? record.durationMs : 0,
  });

  saveTables(getTableStore());
  return { ok: true, table };
}

function deleteTable(tableName) {
  const key = getTableKey(tableName);
  if (!key) {
    return false;
  }

  const store = getTableStore().tables;
  const table = getTableByName(tableName);
  if (!table) {
    return false;
  }

  for (const [storedKey, storedTable] of Object.entries(store)) {
    if (storedTable === table || (typeof storedTable?.name === "string" && storedTable.name.toLowerCase() === key)) {
      delete store[storedKey];
      saveTables(getTableStore());
      return true;
    }
  }

  return false;
}

function renameTable(oldName, newName) {
  const oldKey = getTableKey(oldName);
  const newKey = getTableKey(newName);
  if (!oldKey || !newKey) {
    return { ok: false, reason: "invalid" };
  }

  const store = getTableStore().tables;
  const existing = getTableByName(oldName);
  if (!existing) {
    return { ok: false, reason: "missing" };
  }

  if (getTableByName(newName)) {
    return { ok: false, reason: "exists" };
  }

  let sourceKey = null;
  for (const [storedKey, storedTable] of Object.entries(store)) {
    if (storedTable === existing || (typeof storedTable?.name === "string" && storedTable.name.toLowerCase() === oldKey)) {
      sourceKey = storedKey;
      break;
    }
  }

  if (!sourceKey) {
    return { ok: false, reason: "missing" };
  }

  delete store[sourceKey];
  store[newKey] = {
    ...existing,
    name: newName,
  };
  saveTables(getTableStore());
  return { ok: true };
}

function removeTimerFromTable(tableName, selector) {
  const table = getTableByName(tableName);
  if (!table) {
    return { ok: false, reason: "missing" };
  }

  const ordered = getSortedTimersForTable(table);
  if (ordered.length === 0) {
    return { ok: false, reason: "empty" };
  }

  const normalizedSelector = String(selector || "").trim().toLowerCase();
  let targetIndex = -1;

  if (normalizedSelector === "last") {
    targetIndex = ordered.length - 1;
  } else {
    const parsed = Number.parseInt(normalizedSelector, 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > ordered.length) {
      return { ok: false, reason: "invalid" };
    }
    targetIndex = parsed - 1;
  }

  const target = ordered[targetIndex];
  const actualIndex = table.timers.findIndex((record) =>
    record.timerName === target.timerName &&
    record.startedAtMs === target.startedAtMs &&
    record.stoppedAtMs === target.stoppedAtMs &&
    record.durationMs === target.durationMs
  );

  if (actualIndex === -1) {
    return { ok: false, reason: "missing" };
  }

  const removed = table.timers.splice(actualIndex, 1)[0];
  saveTables(getTableStore());
  return { ok: true, removed, position: targetIndex + 1, table };
}

function getSortedTables() {
  return Object.values(getTableStore().tables).sort((left, right) => left.name.localeCompare(right.name));
}

function getSortedTimersForTable(table) {
  return [...(table?.timers || [])].sort((left, right) => {
    if (right.durationMs !== left.durationMs) {
      return right.durationMs - left.durationMs;
    }

    return right.stoppedAtMs - left.stoppedAtMs;
  });
}

function getTableStats(table) {
  const timers = getSortedTimersForTable(table);
  if (timers.length === 0) {
    return null;
  }

  const totalDurationMs = timers.reduce((sum, record) => sum + (Number(record.durationMs) || 0), 0);
  const slowest = timers[0];
  const fastest = timers[timers.length - 1];
  const averageDurationMs = Math.floor(totalDurationMs / timers.length);

  return {
    count: timers.length,
    totalDurationMs,
    averageDurationMs,
    fastest,
    slowest,
  };
}

function formatStatsLine(label, value) {
  return `- **${label}:** ${value}`;
}

function createTableSelectComponents(promptToken) {
  const availableTables = getSortedTables().slice(0, 25);
  if (availableTables.length === 0) {
    return [];
  }

  const options = availableTables.map((table) => ({
    label: table.name,
    value: table.name,
    description: `${table.timers.length} saved timer${table.timers.length === 1 ? "" : "s"}`.slice(0, 100),
  }));

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`timer-table-select:${promptToken}`)
    .setPlaceholder("Select a table to save this timer")
    .addOptions(options);

  const skipButton = new ButtonBuilder()
    .setCustomId(`timer-table-skip:${promptToken}`)
    .setLabel("Skip")
    .setStyle(ButtonStyle.Secondary);

  return [
    new ActionRowBuilder().addComponents(selectMenu),
    new ActionRowBuilder().addComponents(skipButton),
  ];
}

const tables = loadTables();
const pendingTablePrompts = new Map();

function pauseAndPersistRunningTimer() {
  if (!state.running || state.startedAtMs === null) {
    return false;
  }

  state.accumulatedMs = getElapsedMs(state);
  state.running = false;
  state.startedAtMs = null;
  saveState(state);
  return true;
}

function getLastStoppedTimerRecord() {
  if (!state.lastStoppedTimerRecord) {
    return null;
  }

  const record = state.lastStoppedTimerRecord;
  if (!record || typeof record !== "object") {
    return null;
  }

  return {
    timerName: sanitizeTimerName(record.timerName) || "Timer",
    startedAtMs: Number.isFinite(record.startedAtMs) ? record.startedAtMs : null,
    stoppedAtMs: Number.isFinite(record.stoppedAtMs) ? record.stoppedAtMs : null,
    durationMs: Number.isFinite(record.durationMs) ? record.durationMs : 0,
  };
}

async function promptToAddTimerToTable(message, timerRecord) {
  const availableTables = getSortedTables();
  const promptToken = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  pendingTablePrompts.set(promptToken, {
    userId: message.author.id,
    timerRecord,
  });

  const timeoutHandle = setTimeout(() => {
    pendingTablePrompts.delete(promptToken);
  }, 10 * 60 * 1000);

  if (typeof timeoutHandle.unref === "function") {
    timeoutHandle.unref();
  }

  const tableCount = availableTables.length;
  const content = tableCount > 0
    ? `${message.author}, would you like to add this run to a table?`
    : `${message.author}, no tables exist yet. Create one with \`!timer create table <name>\` so this run can be added later, or skip it for now.`;

  const components = createTableSelectComponents(promptToken);
  const payload = {
    content,
    components,
  };

  try {
    await message.channel.send(payload);
  } catch (error) {
    console.error("Failed to send table prompt:", error?.message || error);
    await message.reply(payload);
  }
}

async function showTable(message, tableName) {
  const normalizedName = sanitizeTimerName(stripOuterQuotes(tableName));
  if (!normalizedName) {
    await message.reply("Provide a table name. Example: `!timer table show Origins`.");
    return;
  }

  const table = getTableByName(normalizedName);
  if (!table) {
    await message.reply("Table **" + normalizedName + "** does not exist. Create it with `!timer create table " + normalizedName + "`.");
    return;
  }

  const timers = getSortedTimersForTable(table);
  if (timers.length === 0) {
    await message.reply(`Table **${table.name}** has no saved timers yet.`);
    return;
  }

  const lines = timers.map((record, index) => formatTimerRecord(record, index));
  const chunks = chunkLines(lines);

  for (let index = 0; index < chunks.length; index += 1) {
    const header = index === 0
      ? [`**Table: ${table.name}**`, `Sorted by longest duration first`, ""]
      : [];
    const content = [...header, chunks[index]].join("\n");

    if (index === 0) {
      await message.reply(content);
    } else {
      await message.channel.send(content);
    }
  }
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
  backupTablesSnapshot();
  scheduleNightlyTableBackup();
  startPresenceUpdates();
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const content = message.content.trim();
  if (!content.toLowerCase().startsWith(PREFIX)) return;

  const commandLine = content.slice(PREFIX.length).trim();
  const args = commandLine.split(/\s+/).filter(Boolean);
  const command = (args.shift() || "status").toLowerCase();
  const remainingLine = commandLine.slice(command.length).trim();

  if (command === "help") {
    await message.reply([
      "**Timer commands**",
      "`!timer` or `!timer status` - show elapsed time",
      "`!timer name <map name>` - set timer/map name",
      "`!timer clearname` - clear timer/map name",
      "`!timer add table <name>` - add the last stopped timer to a table",
      "`!timer create table <name>` - create a timer table",
      "`!timer table show <name>` - show timers saved in a table",
      "`!timer table stats <name>` - show table summary stats",
      "`!timer table delete <name>` - delete a table",
      "`!timer table rename <old> <new>` - rename a table",
      "`!timer table remove <name> <last|index>` - remove a saved timer from a table",
      "`!timer backup now` - back up tables immediately",
      "`!timer start` - start from 00:00:00",
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

  if (command === "create") {
    const createArgs = remainingLine.split(/\s+/).filter(Boolean);
    const createSubcommand = (createArgs.shift() || "").toLowerCase();

    if (createSubcommand !== "table") {
      await message.reply("Unknown create command. Use `!timer create table <name>`.");
      return;
    }

    const tableName = sanitizeTimerName(stripOuterQuotes(createArgs.join(" ")));
    if (!tableName) {
      await message.reply("Provide a table name. Example: `!timer create table Origins`.");
      return;
    }

    const tableKey = getTableKey(tableName);
    if (getTableStore().tables[tableKey] || getTableByName(tableName)) {
      await message.reply(`Table **${tableName}** already exists.`);
      return;
    }

    getTableStore().tables[tableKey] = {
      name: tableName,
      createdAtMs: Date.now(),
      timers: [],
    };
    saveTables(getTableStore());

    await message.reply(`Created table **${tableName}**.`);
    return;
  }

  if (command === "add") {
    const addSubcommand = (args.shift() || "").toLowerCase();

    if (addSubcommand !== "table") {
      await message.reply("Usage: `!timer add table <name>`.");
      return;
    }

    const tableName = sanitizeTimerName(stripOuterQuotes(args.join(" ")));
    if (!tableName) {
      await message.reply("Provide a table name. Example: `!timer add table Origins`.");
      return;
    }

    const lastStoppedTimerRecord = getLastStoppedTimerRecord();
    if (!lastStoppedTimerRecord) {
      await message.reply("There is no stopped timer saved yet. Use `!timer stop` first.");
      return;
    }

    const result = addRecordToTable(tableName, lastStoppedTimerRecord);
    if (!result.ok) {
      if (result.reason === "missing") {
        await message.reply(`Table **${tableName}** was not found.`);
        return;
      }

      await message.reply("Could not add the last stopped timer to that table.");
      return;
    }

    await message.reply(`Added **${lastStoppedTimerRecord.timerName}** to table **${result.table.name}**.`);
    return;
  }

  if (command === "backup") {
    const backupSubcommand = (args.shift() || "").toLowerCase();

    if (backupSubcommand !== "now") {
      await message.reply("Usage: `!timer backup now`.");
      return;
    }

    const succeeded = backupTablesSnapshot();
    if (!succeeded) {
      await message.reply("Could not create a backup right now.");
      return;
    }

    await message.reply("Tables backed up successfully.");
    return;
  }

  if (command === "table") {
    const tableArgs = remainingLine.split(/\s+/).filter(Boolean);
    const tableSubcommand = (tableArgs.shift() || "").toLowerCase();

    if (tableSubcommand === "show") {
      const tableName = tableArgs.join(" ");
      await showTable(message, tableName);
      return;
    }

    if (tableSubcommand === "stats") {
      const tableName = tableArgs.join(" ");
      const normalizedName = sanitizeTimerName(stripOuterQuotes(tableName));

      if (!normalizedName) {
        await message.reply("Usage: `!timer table stats <name>`.");
        return;
      }

      const table = getTableByName(normalizedName);
      if (!table) {
        await message.reply("Table **" + normalizedName + "** was not found.");
        return;
      }

      const stats = getTableStats(table);
      if (!stats) {
        await message.reply(`Table **${table.name}** has no saved timers yet.`);
        return;
      }

      await message.reply([
        `**Table Stats: ${table.name}**`,
        formatStatsLine("Saved runs", stats.count),
        formatStatsLine("Total duration", formatElapsed(stats.totalDurationMs)),
        formatStatsLine("Average duration", formatElapsed(stats.averageDurationMs)),
        formatStatsLine("Fastest run", `${stats.fastest.timerName} - ${formatElapsed(stats.fastest.durationMs)} (${formatDateDMY(stats.fastest.stoppedAtMs)})`),
        formatStatsLine("Slowest run", `${stats.slowest.timerName} - ${formatElapsed(stats.slowest.durationMs)} (${formatDateDMY(stats.slowest.stoppedAtMs)})`),
      ].join("\n"));
      return;
    }

    if (tableSubcommand === "delete") {
      const tableName = tableArgs.join(" ");
      if (!tableName) {
        await message.reply("Usage: `!timer table delete <name>`.");
        return;
      }

      if (!deleteTable(tableName)) {
        await message.reply(`Table **${tableName}** was not found.`);
        return;
      }

      await message.reply(`Deleted table **${tableName}**.`);
      return;
    }

    if (tableSubcommand === "rename") {
      const oldName = tableArgs.shift();
      const newName = tableArgs.join(" ");

      if (!oldName || !newName) {
        await message.reply("Usage: `!timer table rename <old name> <new name>`.");
        return;
      }

      const result = renameTable(oldName, newName);
      if (!result.ok) {
        if (result.reason === "exists") {
          await message.reply(`A table named **${newName}** already exists.`);
          return;
        }

        await message.reply(`Table **${oldName}** was not found.`);
        return;
      }

      await message.reply(`Renamed table **${oldName}** to **${newName}**.`);
      return;
    }

    if (tableSubcommand === "remove") {
      const tableName = tableArgs.shift();
      const selector = tableArgs.join(" ");

      if (!tableName || !selector) {
        await message.reply("Usage: `!timer table remove <name> <last|index>`.");
        return;
      }

      const result = removeTimerFromTable(tableName, selector);
      if (!result.ok) {
        if (result.reason === "empty") {
          await message.reply(`Table **${tableName}** has no saved timers.`);
          return;
        }

        if (result.reason === "invalid") {
          await message.reply("Provide `last` or a timer position like `1`.");
          return;
        }

        await message.reply(`Table **${tableName}** was not found.`);
        return;
      }

      await message.reply(`Removed **${result.removed.timerName}** from **${result.table.name}**.`);
      return;
    }

    if (tableSubcommand === "list") {
      const tableNames = getSortedTables();
      if (tableNames.length === 0) {
        await message.reply("No tables exist yet. Create one with `!timer create table <name>`.");
        return;
      }

      await message.reply([
        "**Tables**",
        ...tableNames.map((table) => `- ${table.name} (${table.timers.length} saved timer${table.timers.length === 1 ? "" : "s"})`),
      ].join("\n"));
      return;
    }

    await message.reply("Unknown table command. Use `!timer table show <name>` or `!timer table list`.");
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
      sessionStartedAtMs: Date.now() - initialMs,
      timerName: state.timerName || null,
      lastStoppedTimerRecord: state.lastStoppedTimerRecord || null,
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
      sessionStartedAtMs: startMs,
      timerName: providedName || state.timerName || null,
      lastStoppedTimerRecord: state.lastStoppedTimerRecord || null,
    };
    saveState(state);
    await updateTimerPresence();

    await message.reply(`Started **${getTimerDisplayName()}** as if it began at **${formatDateDMY(startMs)}**. Current: **${formatElapsed(getElapsedMs(state))}**.`);
    return;
  }

  if (command === "stop") {
    if (!pauseAndPersistRunningTimer()) {
      await message.reply("Timer is already stopped.");
      return;
    }

    const stoppedTimerRecord = buildTimerRecord(state);
    state.lastStoppedTimerRecord = stoppedTimerRecord;
    saveState(state);
    await updateTimerPresence();

    await message.reply(`Stopped **${getTimerDisplayName()}** at **${formatElapsed(state.accumulatedMs)}**.`);
    await promptToAddTimerToTable(message, stoppedTimerRecord);
    return;
  }

  if (command === "resume") {
    if (state.running) {
      await message.reply("Timer is already running.");
      return;
    }

    state.running = true;
    state.startedAtMs = Date.now();
    state.lastStoppedTimerRecord = state.lastStoppedTimerRecord || null;
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
      sessionStartedAtMs: null,
      timerName: state.timerName || null,
      lastStoppedTimerRecord: state.lastStoppedTimerRecord || null,
    };
    saveState(state);
    await updateTimerPresence();

    await message.reply(`${getTimerDisplayName()} reset to **00:00:00** (stopped).`);
    return;
  }

  await message.reply("Unknown command. Use `!timer help`.");
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isStringSelectMenu() && !interaction.isButton()) {
    return;
  }

  const [interactionType, promptToken] = interaction.customId.split(":");
  if (!interactionType || !promptToken) {
    return;
  }

  const pendingPrompt = pendingTablePrompts.get(promptToken);
  if (!pendingPrompt) {
    await interaction.reply({ content: "That table prompt expired.", ephemeral: true });
    return;
  }

  if (interaction.user.id !== pendingPrompt.userId) {
    await interaction.reply({ content: "This prompt is not for you.", ephemeral: true });
    return;
  }

  if (interactionType === "timer-table-skip") {
    pendingTablePrompts.delete(promptToken);
    await interaction.update({ content: "Skipped adding the timer to a table.", components: [] });
    return;
  }

  if (interactionType !== "timer-table-select") {
    return;
  }

  const selectedTableName = interaction.values[0];
  const table = getTableByName(selectedTableName);
  if (!table) {
    await interaction.reply({ content: "That table no longer exists.", ephemeral: true });
    return;
  }

  table.timers.push(pendingPrompt.timerRecord);
  saveTables(getTableStore());
  pendingTablePrompts.delete(promptToken);

  await interaction.update({
    content: `Saved **${pendingPrompt.timerRecord.timerName}** to table **${table.name}**.`,
    components: [],
  });
});

function handleShutdownSignal(signal) {
  const didPersist = pauseAndPersistRunningTimer();
  if (didPersist) {
    console.log(`Saved timer progress before ${signal} shutdown.`);
  }
  process.exit(0);
}

process.on("SIGINT", () => handleShutdownSignal("SIGINT"));
process.on("SIGTERM", () => handleShutdownSignal("SIGTERM"));

client.login(TOKEN);
