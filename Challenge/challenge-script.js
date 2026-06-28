const fs = require("fs");
const path = require("path");
const discord = require("discord.js");
const Client = discord.Client ?? discord.default?.Client;

const GatewayIntentBits = discord.GatewayIntentBits ?? null;
const IntentsFlags = discord.Intents && discord.Intents.FLAGS ? discord.Intents.FLAGS : null;

const MESSAGE_CONTENT_BIT = (GatewayIntentBits && GatewayIntentBits.MessageContent) ?? (IntentsFlags && IntentsFlags.MESSAGE_CONTENT) ?? (1 << 15);
const GUILDS_BIT = (GatewayIntentBits && GatewayIntentBits.Guilds) ?? (IntentsFlags && IntentsFlags.GUILDS) ?? (1 << 0);
const GUILD_MESSAGES_BIT = (GatewayIntentBits && GatewayIntentBits.GuildMessages) ?? (IntentsFlags && IntentsFlags.GUILD_MESSAGES) ?? (1 << 9);

const intentsArray = [
  GUILDS_BIT,
  GUILD_MESSAGES_BIT,
  MESSAGE_CONTENT_BIT,
].filter(Boolean);

require("dotenv").config();

const TOKEN = process.env.DISCORD_TOKEN;
const PREFIX = "!challenge";
const GAMES_FILE = path.join(__dirname, "games.json");
const STATE_FILE = path.join(__dirname, "challenge-state.json");
const CHALLENGE_CATALOG_FILE = path.join(__dirname, "challenge-catalog.json");
const CHALLENGE_TABLES_FILE = path.join(__dirname, "challenge-tables.json");
const CHALLENGE_TABLE_BACKUP_DIR = path.join(__dirname, "..", "backups", "Table Backups", "Challenge");

if (require.main === module && !TOKEN) {
  console.error("Missing DISCORD_TOKEN in environment.");
  process.exit(1);
}

function loadAllowedGames() {
  try {
    const raw = fs.readFileSync(GAMES_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const games = Array.isArray(parsed.allowedGames) ? parsed.allowedGames : [];
    return games.filter((game) => typeof game === "string" && game.trim().length > 0);
  } catch {
    return [];
  }
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return { activeChallenge: null, history: [] };
  }

  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      activeChallenge: parsed.activeChallenge && typeof parsed.activeChallenge === "object"
        ? parsed.activeChallenge
        : null,
      history: Array.isArray(parsed.history) ? parsed.history : [],
    };
  } catch {
    return { activeChallenge: null, history: [] };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadChallengeCatalog() {
  if (!fs.existsSync(CHALLENGE_CATALOG_FILE)) {
    return { games: {} };
  }

  try {
    const raw = fs.readFileSync(CHALLENGE_CATALOG_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      games: parsed && typeof parsed.games === "object" && parsed.games !== null
        ? parsed.games
        : {},
    };
  } catch {
    return { games: {} };
  }
}

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

function resolveGameCatalogEntry(catalog, gameName) {
  const games = catalog.games || {};
  if (games[gameName]) {
    return games[gameName];
  }

  const needle = normalizeKey(gameName);
  for (const [name, entry] of Object.entries(games)) {
    if (normalizeKey(name) === needle) {
      return entry;
    }
  }

  return null;
}

function resolveMapOverride(gameEntry, mapName) {
  const overrides = gameEntry && typeof gameEntry.mapOverrides === "object" && gameEntry.mapOverrides !== null
    ? gameEntry.mapOverrides
    : {};

  if (overrides[mapName]) {
    return overrides[mapName];
  }

  const needle = normalizeKey(mapName);
  for (const [name, entry] of Object.entries(overrides)) {
    if (normalizeKey(name) === needle) {
      return entry;
    }
  }

  return null;
}

function uniqueStrings(values) {
  const set = new Set();
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }

    const normalized = value.trim();
    if (!normalized) {
      continue;
    }

    if (!set.has(normalized)) {
      set.add(normalized);
    }
  }

  return [...set];
}

function resolveChallengesByType(source, type, difficultyKey) {
  if (!source || typeof source !== "object") {
    return [];
  }

  const typed = source[type];
  if (!typed || typeof typed !== "object") {
    return [];
  }

  const exact = typed[difficultyKey];
  if (Array.isArray(exact)) {
    return uniqueStrings(exact);
  }

  const normal = typed.normal;
  if (Array.isArray(normal)) {
    return uniqueStrings(normal);
  }

  return [];
}

function getChallengePools(catalog, gameName, mapName, difficulty) {
  const gameEntry = resolveGameCatalogEntry(catalog, gameName);
  if (!gameEntry) {
    return { global: [], individual: [] };
  }

  const difficultyKey = normalizeKey(difficulty) || "normal";
  const defaults = gameEntry.allMaps || {};
  const mapOverride = resolveMapOverride(gameEntry, mapName) || {};

  const global = uniqueStrings([
    ...resolveChallengesByType(defaults, "global", difficultyKey),
    ...resolveChallengesByType(mapOverride, "global", difficultyKey),
  ]);

  const individual = uniqueStrings([
    ...resolveChallengesByType(defaults, "individual", difficultyKey),
    ...resolveChallengesByType(mapOverride, "individual", difficultyKey),
  ]);

  return { global, individual };
}

function matchGamePrefix(input, allowedGames) {
  const normalizedInput = input.trim();
  const sortedGames = [...allowedGames].sort((left, right) => right.length - left.length);

  for (const game of sortedGames) {
    const gameLower = game.toLowerCase();
    if (!normalizedInput.toLowerCase().startsWith(gameLower)) {
      continue;
    }

    const boundaryChar = normalizedInput.charAt(game.length);
    if (boundaryChar && boundaryChar !== " ") {
      continue;
    }

    const remainder = normalizedInput.slice(game.length).trim();
    return { game, remainder };
  }

  return null;
}

function parseStartInput(input, allowedGames) {
  const matched = matchGamePrefix(input, allowedGames);
  if (!matched) {
    return { ok: false, reason: "game" };
  }

  const parts = matched.remainder.split(/\s+/).filter(Boolean);
  if (parts.length < 5) {
    return { ok: false, reason: "format", game: matched.game };
  }

  let globalCountIndex = -1;
  for (let index = parts.length - 3; index >= 1; index -= 1) {
    const globalCount = Number.parseInt(parts[index], 10);
    const individualCount = Number.parseInt(parts[index + 1], 10);
    if (Number.isInteger(globalCount) && globalCount > 0 && Number.isInteger(individualCount) && individualCount > 0) {
      globalCountIndex = index;
      break;
    }
  }

  if (globalCountIndex === -1) {
    return { ok: false, reason: "count", game: matched.game };
  }

  const globalChallengeCount = Number.parseInt(parts[globalCountIndex], 10);
  const individualChallengeCount = Number.parseInt(parts[globalCountIndex + 1], 10);
  const difficulty = (parts[globalCountIndex - 1] || "").trim();
  const mapName = parts.slice(0, globalCountIndex - 1).join(" ").trim();
  const tagsRaw = parts.slice(globalCountIndex + 2).join(" ").trim();

  if (!mapName) {
    return { ok: false, reason: "map", game: matched.game };
  }

  if (!difficulty) {
    return { ok: false, reason: "difficulty", game: matched.game, mapName };
  }

  if (!tagsRaw) {
    return { ok: false, reason: "tags", game: matched.game, mapName, difficulty, globalChallengeCount, individualChallengeCount };
  }

  const gamertags = tagsRaw.includes(",")
    ? tagsRaw.split(",").map((item) => item.trim()).filter(Boolean)
    : tagsRaw.split(/\s+/).filter(Boolean);

  if (gamertags.length === 0) {
    return { ok: false, reason: "tags", game: matched.game, mapName, difficulty, globalChallengeCount, individualChallengeCount };
  }

  return {
    ok: true,
    game: matched.game,
    mapName,
    difficulty,
    globalChallengeCount,
    individualChallengeCount,
    playerCount: gamertags.length,
    gamertags,
  };
}

function shuffleValues(values) {
  const shuffled = [...values];

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }

  return shuffled;
}

function selectGlobalChallenges(globalPool, requestedCount) {
  if (!Array.isArray(globalPool) || globalPool.length === 0) {
    return [];
  }

  const safeCount = Math.max(0, Number.parseInt(requestedCount, 10) || 0);
  return shuffleValues(globalPool).slice(0, Math.min(safeCount, globalPool.length));
}

function assignIndividualChallenges(gamertags, individualPool, requestedCount) {
  if (!Array.isArray(gamertags) || gamertags.length === 0) {
    return [];
  }

  const pool = Array.isArray(individualPool) ? individualPool.filter(Boolean) : [];
  const safeCount = Math.max(0, Number.parseInt(requestedCount, 10) || 0);

  return gamertags.map((gamertag) => {
    if (pool.length === 0 || safeCount === 0) {
      return {
        gamertag,
        assignedChallenges: [],
        challenges: [],
      };
    }

    let shuffledPool = shuffleValues(pool);
    const assignedChallenges = [];

    while (assignedChallenges.length < safeCount) {
      if (shuffledPool.length === 0) {
        shuffledPool = shuffleValues(pool);
      }

      assignedChallenges.push(shuffledPool.shift());
    }

    return {
      gamertag,
      assignedChallenges,
      challenges: assignedChallenges,
    };
  });
}

function formatChallenge(challenge) {
  const challengeType = challenge.challengeType || "Easter Egg Run";
  const mapName = challenge.mapName || "Unknown Map";
  const difficulty = challenge.difficulty || "Unknown";

  return [
    `Type: **${challengeType}**`,
    `Game: **${challenge.game}**`,
    `Map: **${mapName}**`,
    `Difficulty: **${difficulty}**`,
    `Players: **${challenge.playerCount || 0}**`,
  ].join("\n");
}

function formatPlayerChallenges(challenge) {
  const perPlayer = Array.isArray(challenge.playerChallenges)
    ? challenge.playerChallenges
    : (challenge.gamertags || []).map((tag) => ({ gamertag: tag }));

  if (perPlayer.length === 0) {
    return "- None";
  }

  return perPlayer
    .map((entry) => {
      const assignedChallenges = Array.isArray(entry.assignedChallenges) && entry.assignedChallenges.length > 0
        ? entry.assignedChallenges
        : (Array.isArray(entry.challenges) && entry.challenges.length > 0 ? entry.challenges : []);

      const formattedChallenges = assignedChallenges.length > 0
        ? assignedChallenges.join(", ")
        : "No challenge assigned";

      return `- ${entry.gamertag} - ${formattedChallenges}`;
    })
    .join("\n");
}

function formatChallengeList(title, challenges) {
  if (!Array.isArray(challenges) || challenges.length === 0) {
    return [`**${title}**`, "- No challenges configured"].join("\n");
  }

  return [
    `**${title}**`,
    ...challenges.map((item) => `- ${item}`),
  ].join("\n");
}

function stripOuterQuotes(input) {
  const value = String(input || "").trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).trim();
  }
  return value;
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

function formatStatsLine(label, value) {
  return `- **${label}:** ${value}`;
}

function sanitizeTableName(input) {
  const value = String(input || "").trim();
  if (!value) {
    return null;
  }
  return value.slice(0, 60);
}

function loadChallengeTables() {
  if (!fs.existsSync(CHALLENGE_TABLES_FILE)) {
    return { tables: {} };
  }

  try {
    const raw = fs.readFileSync(CHALLENGE_TABLES_FILE, "utf8");
    const data = JSON.parse(raw);
    const sourceTables = data && typeof data.tables === "object" && data.tables !== null ? data.tables : {};
    const tables = {};

    for (const [name, table] of Object.entries(sourceTables)) {
      const normalizedName = sanitizeTableName(name);
      if (!normalizedName) {
        continue;
      }

      const challenges = Array.isArray(table?.challenges)
        ? table.challenges.filter((challenge) => challenge && typeof challenge === "object")
        : [];

      tables[normalizedName] = {
        name: normalizedName,
        createdAtMs: Number.isFinite(table?.createdAtMs) ? table.createdAtMs : Date.now(),
        challenges,
      };
    }

    return { tables };
  } catch {
    return { tables: {} };
  }
}

function saveChallengeTables(tableStore) {
  fs.writeFileSync(CHALLENGE_TABLES_FILE, JSON.stringify(tableStore, null, 2));
}

function formatBackupDate(date) {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function backupChallengeTablesSnapshot() {
  try {
    if (!fs.existsSync(CHALLENGE_TABLES_FILE)) {
      return false;
    }

    fs.mkdirSync(CHALLENGE_TABLE_BACKUP_DIR, { recursive: true });

    const backupDate = formatBackupDate(new Date());
    const backupFile = path.join(CHALLENGE_TABLE_BACKUP_DIR, `challenge-tables-${backupDate}.json`);
    const source = fs.readFileSync(CHALLENGE_TABLES_FILE, "utf8");
    fs.writeFileSync(backupFile, source);

    console.log(`Backed up challenge tables to ${backupFile}`);
    return true;
  } catch (error) {
    console.error("Failed to back up challenge tables:", error?.message || error);
    return false;
  }
}

function scheduleNightlyChallengeTableBackup() {
  const now = new Date();
  const nextRun = new Date(now);
  nextRun.setHours(24, 0, 0, 0);

  const delayMs = nextRun.getTime() - now.getTime();
  const timeout = setTimeout(() => {
    backupChallengeTablesSnapshot();

    const interval = setInterval(() => {
      backupChallengeTablesSnapshot();
    }, 24 * 60 * 60 * 1000);

    if (typeof interval.unref === "function") {
      interval.unref();
    }
  }, delayMs);

  if (typeof timeout.unref === "function") {
    timeout.unref();
  }
}

function getChallengeTableKey(input) {
  const value = sanitizeTableName(input);
  return value ? value.toLowerCase() : null;
}

function getChallengeTableStore() {
  return challengeTables;
}

function getChallengeTableByName(tableName) {
  const key = getChallengeTableKey(tableName);
  if (!key) {
    return null;
  }

  const store = getChallengeTableStore().tables;
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

function addChallengeToTable(tableName, challenge) {
  const key = getChallengeTableKey(tableName);
  if (!key || !challenge) {
    return { ok: false, reason: "invalid" };
  }

  const store = getChallengeTableStore().tables;
  const table = getChallengeTableByName(tableName);
  if (!table) {
    return { ok: false, reason: "missing" };
  }

  table.challenges.push({
    id: challenge.id,
    game: challenge.game || "Unknown",
    mapName: challenge.mapName || "Unknown",
    difficulty: challenge.difficulty || "Unknown",
    playerCount: Number.isFinite(challenge.playerCount) ? challenge.playerCount : 0,
    globalChallengeCount: Number.isFinite(challenge.globalChallengeCount) ? challenge.globalChallengeCount : 0,
    individualChallengeCount: Number.isFinite(challenge.individualChallengeCount) ? challenge.individualChallengeCount : 0,
    gamertags: Array.isArray(challenge.gamertags) ? challenge.gamertags : [],
    status: typeof challenge.status === "string" ? challenge.status : "Unknown",
    globalChallenges: Array.isArray(challenge.globalChallenges) ? challenge.globalChallenges : [],
    playerChallenges: Array.isArray(challenge.playerChallenges) ? challenge.playerChallenges : [],
    createdAtMs: Number.isFinite(challenge.createdAtMs) ? challenge.createdAtMs : Date.now(),
    endedAtMs: Number.isFinite(challenge.endedAtMs) ? challenge.endedAtMs : null,
  });

  saveChallengeTables(getChallengeTableStore());
  return { ok: true, table };
}

function removeChallengeFromTable(tableName, selector) {
  const table = getChallengeTableByName(tableName);
  if (!table) {
    return { ok: false, reason: "missing" };
  }

  if (table.challenges.length === 0) {
    return { ok: false, reason: "empty" };
  }

  const normalizedSelector = String(selector || "").trim().toLowerCase();
  let targetIndex = -1;

  if (normalizedSelector === "last") {
    targetIndex = table.challenges.length - 1;
  } else {
    const parsed = Number.parseInt(normalizedSelector, 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > table.challenges.length) {
      return { ok: false, reason: "invalid" };
    }
    targetIndex = parsed - 1;
  }

  const removed = table.challenges.splice(targetIndex, 1)[0];
  saveChallengeTables(getChallengeTableStore());
  return { ok: true, removed, position: targetIndex + 1, table };
}

function deleteTable(tableName) {
  const key = getChallengeTableKey(tableName);
  if (!key) {
    return { ok: false, reason: "invalid" };
  }

  const store = getChallengeTableStore().tables;
  if (!store[key]) {
    return { ok: false, reason: "missing" };
  }

  delete store[key];
  saveChallengeTables(getChallengeTableStore());
  return { ok: true };
}

function renameTable(oldName, newName) {
  const oldKey = getChallengeTableKey(oldName);
  const newKey = getChallengeTableKey(newName);
  if (!oldKey || !newKey) {
    return { ok: false, reason: "invalid" };
  }

  const store = getChallengeTableStore().tables;
  const table = store[oldKey];
  if (!table) {
    return { ok: false, reason: "missing" };
  }

  if (store[newKey] && oldKey !== newKey) {
    return { ok: false, reason: "exists" };
  }

  table.name = sanitizeTableName(newName);
  delete store[oldKey];
  store[newKey] = table;
  saveChallengeTables(getChallengeTableStore());
  return { ok: true, table };
}

function getSortedChallengesForTable(table) {
  return [...(table?.challenges || [])].sort((left, right) => {
    return right.createdAtMs - left.createdAtMs;
  });
}

function getSortedChallengeTables() {
  return Object.values(getChallengeTableStore().tables).sort((left, right) => left.name.localeCompare(right.name));
}

function getChallengeTableStats(table) {
  const challenges = getSortedChallengesForTable(table);
  if (challenges.length === 0) {
    return null;
  }

  return {
    count: challenges.length,
    newest: challenges[0],
    oldest: challenges[challenges.length - 1],
  };
}

function formatChallengeRecord(challenge, index) {
  const playerNamesFromTags = Array.isArray(challenge.gamertags)
    ? challenge.gamertags.filter((value) => typeof value === "string" && value.trim().length > 0)
    : [];

  const playerNamesFromAssignments = Array.isArray(challenge.playerChallenges)
    ? challenge.playerChallenges
      .map((entry) => entry && typeof entry.gamertag === "string" ? entry.gamertag.trim() : "")
      .filter(Boolean)
    : [];

  const playerNames = (playerNamesFromTags.length > 0 ? playerNamesFromTags : playerNamesFromAssignments).join(", ") || "None";
  const rawStatus = String(challenge.status || "Unknown").trim().toLowerCase();
  const status = rawStatus === "complete" || rawStatus === "completed"
    ? "Completed"
    : (rawStatus === "failed" ? "Failed" : "Unknown");

  return `${String(index + 1).padStart(2, "0")}. ${challenge.game || "Unknown"} - ${challenge.mapName || "Unknown"} - ${challenge.difficulty || "Unknown"} - ${Number.isFinite(challenge.globalChallengeCount) ? challenge.globalChallengeCount : 0} Group Challenges - ${Number.isFinite(challenge.individualChallengeCount) ? challenge.individualChallengeCount : 0} Individual Challenges - ${playerNames} - ${status}`;
}

async function promptToAddChallengeToTable(message) {
  const availableTables = getSortedChallengeTables();
  if (availableTables.length === 0) {
    await message.channel.send([
      `${message.author}, would you like to add this challenge to a table?`,
      "No challenge tables exist yet.",
      "Create one with: `!challenge create table <name>`",
      "Then add this challenge with: `!challenge add table <name>`",
    ].join("\n"));
    return;
  }

  await message.channel.send([
    `${message.author}, would you like to add this challenge to a table?`,
    "Add it with: `!challenge add table <name>`",
    "See all table names with: `!challenge table show all`",
  ].join("\n"));
}

let allowedGames = loadAllowedGames();
let state = loadState();
let challengeCatalog = loadChallengeCatalog();
let challengeTables = loadChallengeTables();

function registerChallengeHandlers(client) {
  client.on("messageCreate", async (message) => {
    if (message.author.bot) return;

    const content = message.content.trim();
    if (!content.toLowerCase().startsWith(PREFIX)) return;

    const body = content.slice(PREFIX.length).trim();
    const args = body.split(/\s+/).filter(Boolean);
    const command = (args.shift() || "help").toLowerCase();
    const remaining = body.slice(command.length).trim();

    if (command === "help") {
      await message.reply([
        "**Challenge commands**",
        "`!challenge games` - list allowed games",
        "`!challenge start <game> <map> <difficulty> <globalChallengeCount> <individualChallengeCount> <gamertag1,gamertag2,...>` - start an Easter Egg Run challenge",
        "`!challenge status` - show current challenge",
        "`!challenge end <Completed|Failed>` - end current challenge",
        "`!challenge create table <name>` - create a challenge table",
        "`!challenge add table <name>` - add the last ended challenge to a table",
        "`!challenge table show <name>` - show challenges saved in a table",
        "`!challenge table show all` - show all table names",
        "`!challenge table stats <name>` - show table summary stats",
        "`!challenge table delete <name>` - delete a table",
        "`!challenge table rename <old> <new>` - rename a table",
        "`!challenge table remove <name> <last|index>` - remove a saved challenge from a table",
        "`!challenge backup now` - back up challenge tables immediately",
        "",
        "Example:",
        "`!challenge start Black Ops 3 Der Eisendrache Difficult 3 2 Merlin,Michael,Joe,Charlie`",
      ].join("\n"));
      return;
    }

    if (command === "games") {
      allowedGames = loadAllowedGames();
      if (allowedGames.length === 0) {
        await message.reply("No games configured. Update `Challenge/games.json`.");
        return;
      }

      await message.reply([
        "**Allowed Games**",
        ...allowedGames.map((game) => `- ${game}`),
      ].join("\n"));
      return;
    }

    if (command === "status") {
      if (!state.activeChallenge) {
        await message.reply("No active challenge right now.");
        return;
      }

      await message.reply([
        "**Active Challenge**",
        formatChallenge(state.activeChallenge),
        "",
        formatChallengeList("Global Challenges", state.activeChallenge.globalChallenges || []),
        "",
        "**Per-Player Challenges**",
        formatPlayerChallenges(state.activeChallenge),
        `Started: **${new Date(state.activeChallenge.createdAtMs).toISOString()}**`,
      ].join("\n"));
      return;
    }

    if (command === "start") {
      if (state.activeChallenge) {
        await message.reply([
          "An Easter Egg Run challenge is already active.",
          formatChallenge(state.activeChallenge),
          "Use `!challenge end` before starting another.",
        ].join("\n"));
        return;
      }

      allowedGames = loadAllowedGames();
      challengeCatalog = loadChallengeCatalog();
      const parsed = parseStartInput(remaining, allowedGames);

      if (!parsed.ok) {
        if (parsed.reason === "game") {
          await message.reply("Invalid game. Use `!challenge games` to see valid options.");
          return;
        }

        if (parsed.reason === "format") {
          await message.reply("Please include map, difficulty, global challenge count, individual challenge count, and gamertags. Example: `!challenge start Black Ops 3 Der Eisendrache Difficult 3 2 Merl,Alex,Sam,Chris`");
          return;
        }

        if (parsed.reason === "count") {
          await message.reply("Please include valid global and individual challenge counts before gamertags. Example: `!challenge start Black Ops 3 Der Eisendrache Difficult 3 2 Merl,Alex,Sam,Chris`");
          return;
        }

        if (parsed.reason === "map") {
          await message.reply("Please include a map name. Example: `!challenge start Black Ops 3 Der Eisendrache Difficult 3 2 Merl,Alex,Sam,Chris`");
          return;
        }

        if (parsed.reason === "difficulty") {
          await message.reply("Please include a difficulty. Example: `!challenge start Black Ops 3 Der Eisendrache Difficult 3 2 Merl,Alex,Sam,Chris`");
          return;
        }

        if (parsed.reason === "tags") {
          await message.reply("Please include gamer tags separated by commas. Example: `!challenge start Black Ops 3 Der Eisendrache Difficult 3 2 Merl,Alex,Sam,Chris`");
          return;
        }

        await message.reply("Could not parse challenge start command.");
        return;
      }

      const pools = getChallengePools(challengeCatalog, parsed.game, parsed.mapName, parsed.difficulty);
      const selectedGlobalChallenges = selectGlobalChallenges(pools.global, parsed.globalChallengeCount);
      const playerChallenges = assignIndividualChallenges(parsed.gamertags, pools.individual, parsed.individualChallengeCount);

      state.activeChallenge = {
        id: `${Date.now()}`,
        challengeType: "Easter Egg Run",
        game: parsed.game,
        mapName: parsed.mapName,
        difficulty: parsed.difficulty,
        playerCount: parsed.playerCount,
        globalChallengeCount: parsed.globalChallengeCount,
        individualChallengeCount: parsed.individualChallengeCount,
        gamertags: parsed.gamertags,
        globalChallenges: selectedGlobalChallenges,
        playerChallenges,
        createdByUserId: message.author.id,
        createdAtMs: Date.now(),
      };
      saveState(state);

      await message.reply([
        "**Challenge Started**",
        formatChallenge(state.activeChallenge),
        "",
        formatChallengeList("Global Challenges", state.activeChallenge.globalChallenges || []),
        "",
        "**Per-Player Challenges**",
        formatPlayerChallenges(state.activeChallenge),
      ].join("\n"));
      return;
    }

    if (command === "end") {
      if (!state.activeChallenge) {
        await message.reply("No active challenge to end.");
        return;
      }

      const statusArg = (args.shift() || "").toLowerCase();
      if (statusArg !== "complete" && statusArg !== "completed" && statusArg !== "failed") {
        await message.reply("Please specify `!challenge end Completed` or `!challenge end Failed`.");
        return;
      }

      const status = statusArg === "failed" ? "Failed" : "Completed";

      const finished = {
        ...state.activeChallenge,
        status,
        endedAtMs: Date.now(),
        endedByUserId: message.author.id,
      };

      state.history.push(finished);
      state.activeChallenge = null;
      saveState(state);

      await message.reply([
        `**Challenge ${status}**`,
        formatChallenge(finished),
        "",
        formatChallengeList("Global Challenges", finished.globalChallenges || []),
        "",
        "**Per-Player Challenges**",
        formatPlayerChallenges(finished),
        `Ended: **${new Date(finished.endedAtMs).toISOString()}**`,
      ].join("\n"));

      await promptToAddChallengeToTable(message);
      return;
    }

    if (command === "create") {
      const createSubcommand = (args.shift() || "").toLowerCase();
      if (createSubcommand === "table") {
        const tableName = sanitizeTableName(args.join(" "));
        if (!tableName) {
          await message.reply("Provide a table name. Example: `!challenge create table Black Ops 3`");
          return;
        }

        const existing = getChallengeTableByName(tableName);
        if (existing) {
          await message.reply(`Table **${tableName}** already exists.`);
          return;
        }

        const store = getChallengeTableStore().tables;
        const key = getChallengeTableKey(tableName);
        store[key] = {
          name: tableName,
          createdAtMs: Date.now(),
          challenges: [],
        };
        saveChallengeTables(getChallengeTableStore());

        await message.reply(`Created challenge table **${tableName}**.`);
        return;
      }

      await message.reply("Unknown create command. Use `!challenge create table <name>`.");
      return;
    }

    if (command === "add") {
      const addSubcommand = (args.shift() || "").toLowerCase();
      if (addSubcommand === "table") {
        if (!state.activeChallenge && state.history.length === 0) {
          await message.reply("No challenge to add. Complete or end a challenge first.");
          return;
        }

        const tableName = sanitizeTableName(args.join(" "));
        if (!tableName) {
          await message.reply("Provide a table name. Example: `!challenge add table Black Ops 3`");
          return;
        }

        const table = getChallengeTableByName(tableName);
        if (!table) {
          await message.reply(`Table **${tableName}** does not exist. Create it with \`!challenge create table ${tableName}\`.`);
          return;
        }

        const lastChallenge = state.history.length > 0 ? state.history[state.history.length - 1] : null;
        if (!lastChallenge) {
          await message.reply("No completed challenge to add.");
          return;
        }

        const result = addChallengeToTable(tableName, lastChallenge);
        if (!result.ok) {
          await message.reply("Could not add challenge to table.");
          return;
        }

        await message.reply(`Added challenge to table **${tableName}**.`);
        return;
      }

      await message.reply("Unknown add command. Use `!challenge add table <name>`.");
      return;
    }

    if (command === "table") {
      const tableArgs = remaining.split(/\s+/).filter(Boolean);
      const tableSubcommand = (tableArgs.shift() || "").toLowerCase();

      if (tableSubcommand === "show") {
        const tableNameOrAll = tableArgs.join(" ").toLowerCase();
        if (tableNameOrAll === "all") {
          const tableNames = getSortedChallengeTables();
          if (tableNames.length === 0) {
            await message.reply("No challenge tables exist yet. Create one with `!challenge create table <name>`.");
            return;
          }

          await message.reply([
            "**All Challenge Tables**",
            ...tableNames.map((table) => `- ${table.name}`),
          ].join("\n"));
          return;
        }

        const tableName = tableArgs.join(" ");
        const normalizedName = sanitizeTableName(stripOuterQuotes(tableName));
        if (!normalizedName) {
          await message.reply("Provide a table name. Example: `!challenge table show Black Ops 3`.");
          return;
        }

        const table = getChallengeTableByName(normalizedName);
        if (!table) {
          await message.reply("Table **" + normalizedName + "** does not exist. Create it with `!challenge create table " + normalizedName + "`.");
          return;
        }

        const challenges = getSortedChallengesForTable(table);
        if (challenges.length === 0) {
          await message.reply(`Table **${table.name}** has no saved challenges yet.`);
          return;
        }

        const lines = challenges.map((challenge, index) => formatChallengeRecord(challenge, index));
        const chunks = chunkLines(lines);

        for (let index = 0; index < chunks.length; index += 1) {
          const header = index === 0
            ? [`**Table: ${table.name}**`, `Sorted by newest first`, ""]
            : [];
          const content = [...header, chunks[index]].join("\n");

          if (index === 0) {
            await message.reply(content);
          } else {
            await message.channel.send(content);
          }
        }
        return;
      }

      if (tableSubcommand === "stats") {
        const tableName = tableArgs.join(" ");
        const normalizedName = sanitizeTableName(stripOuterQuotes(tableName));

        if (!normalizedName) {
          await message.reply("Usage: `!challenge table stats <name>`.");
          return;
        }

        const table = getChallengeTableByName(normalizedName);
        if (!table) {
          await message.reply("Table **" + normalizedName + "** was not found.");
          return;
        }

        const stats = getChallengeTableStats(table);
        if (!stats) {
          await message.reply(`Table **${table.name}** has no saved challenges yet.`);
          return;
        }

        await message.reply([
          `**Table Stats: ${table.name}**`,
          formatStatsLine("Saved challenges", stats.count),
          formatStatsLine("Newest", `${stats.newest.game} - ${stats.newest.mapName}`),
          formatStatsLine("Oldest", `${stats.oldest.game} - ${stats.oldest.mapName}`),
        ].join("\n"));
        return;
      }

      if (tableSubcommand === "delete") {
        const tableName = tableArgs.join(" ");
        const normalizedName = sanitizeTableName(stripOuterQuotes(tableName));

        if (!normalizedName) {
          await message.reply("Usage: `!challenge table delete <name>`.");
          return;
        }

        const result = deleteTable(normalizedName);
        if (!result.ok) {
          if (result.reason === "missing") {
            await message.reply(`Table **${normalizedName}** was not found.`);
            return;
          }
          await message.reply("Could not delete table.");
          return;
        }

        await message.reply(`Deleted challenge table **${normalizedName}**.`);
        return;
      }

      if (tableSubcommand === "rename") {
        const oldName = stripOuterQuotes((tableArgs.shift() || "").trim());
        const newName = stripOuterQuotes(tableArgs.join(" ").trim());

        if (!oldName || !newName) {
          await message.reply("Usage: `!challenge table rename <old name> <new name>`.");
          return;
        }

        const result = renameTable(oldName, newName);
        if (!result.ok) {
          if (result.reason === "missing") {
            await message.reply(`Table **${oldName}** was not found.`);
            return;
          }
          if (result.reason === "exists") {
            await message.reply(`Table **${newName}** already exists.`);
            return;
          }
          await message.reply("Could not rename table.");
          return;
        }

        await message.reply(`Renamed table to **${result.table.name}**.`);
        return;
      }

      if (tableSubcommand === "remove") {
        const tableArgs2 = tableArgs.slice();
        const selector = (tableArgs2.pop() || "").trim();
        const tableName = tableArgs2.join(" ").trim();

        if (!tableName || !selector) {
          await message.reply("Usage: `!challenge table remove <name> <last|index>`.");
          return;
        }

        const result = removeChallengeFromTable(tableName, selector);
        if (!result.ok) {
          if (result.reason === "empty") {
            await message.reply(`Table **${tableName}** has no saved challenges.`);
            return;
          }

          if (result.reason === "invalid") {
            await message.reply("Provide `last` or a challenge position like `1`.");
            return;
          }

          await message.reply(`Table **${tableName}** was not found.`);
          return;
        }

        await message.reply(`Removed challenge from **${result.table.name}** (position ${result.position}).`);
        return;
      }

      await message.reply("Unknown table command. Use `!challenge table show <name>`, `!challenge table show all`, or `!challenge table stats <name>`.");
      return;
    }

    if (command === "backup") {
      const backupSubcommand = (args.shift() || "").toLowerCase();

      if (backupSubcommand !== "now") {
        await message.reply("Usage: `!challenge backup now`.");
        return;
      }

      const succeeded = backupChallengeTablesSnapshot();
      if (!succeeded) {
        await message.reply("Could not create a backup right now.");
        return;
      }

      await message.reply("Challenge tables backed up successfully.");
      return;
    }

    await message.reply("Unknown challenge command. Use `!challenge help`.");
  });
}

if (require.main === module) {
  if (!TOKEN) {
    console.error("Missing DISCORD_TOKEN in environment.");
    process.exit(1);
  }

  const client = new Client({ intents: intentsArray });
  client.on("ready", () => {
    console.log(`Challenge bot logged in as ${client.user.tag}`);
  });

  backupChallengeTablesSnapshot();
  scheduleNightlyChallengeTableBackup();

  registerChallengeHandlers(client);
  client.login(TOKEN);
}

module.exports = {
  registerChallengeHandlers,
  backupChallengeTablesSnapshot,
  scheduleNightlyChallengeTableBackup,
};
