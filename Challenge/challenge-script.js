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

if (!TOKEN) {
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
  if (parts.length < 4) {
    return { ok: false, reason: "format", game: matched.game };
  }

  let countIndex = -1;
  for (let index = parts.length - 2; index >= 1; index -= 1) {
    const parsed = Number.parseInt(parts[index], 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      countIndex = index;
      break;
    }
  }

  if (countIndex === -1) {
    return { ok: false, reason: "count", game: matched.game };
  }

  const playerCount = Number.parseInt(parts[countIndex], 10);
  const difficulty = (parts[countIndex - 1] || "").trim();
  const mapName = parts.slice(0, countIndex - 1).join(" ").trim();
  const tagsRaw = parts.slice(countIndex + 1).join(" ").trim();

  if (!mapName) {
    return { ok: false, reason: "map", game: matched.game };
  }

  if (!difficulty) {
    return { ok: false, reason: "difficulty", game: matched.game, mapName };
  }

  if (!tagsRaw) {
    return { ok: false, reason: "tags", game: matched.game, mapName, difficulty, playerCount };
  }

  const gamertags = tagsRaw.includes(",")
    ? tagsRaw.split(",").map((item) => item.trim()).filter(Boolean)
    : tagsRaw.split(/\s+/).filter(Boolean);

  if (gamertags.length !== playerCount) {
    return {
      ok: false,
      reason: "mismatch",
      game: matched.game,
      mapName,
      difficulty,
      playerCount,
      countProvided: gamertags.length,
      gamertags,
    };
  }

  return {
    ok: true,
    game: matched.game,
    mapName,
    difficulty,
    playerCount,
    gamertags,
  };
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
    .map((entry) => `- ${entry.gamertag}`)
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

const client = new Client({ intents: intentsArray });

let allowedGames = loadAllowedGames();
let state = loadState();
let challengeCatalog = loadChallengeCatalog();

client.on("ready", () => {
  console.log(`Challenge bot logged in as ${client.user.tag}`);
});

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
      "`!challenge start <game> <map> <difficulty> <playerCount> <gamertag1,gamertag2,...>` - start an Easter Egg Run challenge",
      "`!challenge status` - show current challenge",
      "`!challenge end` - end current challenge",
      "",
      "Example:",
      "`!challenge start Black Ops 3 Der Eisendrache Difficult 4 Merl,Alex,Sam,Chris`",
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
      "**Global Challenge**",
      formatChallenge(state.activeChallenge),
      formatChallengeList("Global Challenge Pool", state.activeChallenge.globalChallenges || []),
      formatChallengeList("Individual Challenge Pool", state.activeChallenge.individualChallenges || []),
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
        await message.reply("Please include map, difficulty, player count, and gamertags. Example: `!challenge start Black Ops 3 Der Eisendrache Difficult 4 Merl,Alex,Sam,Chris`");
        return;
      }

      if (parsed.reason === "count") {
        await message.reply("Please include a valid player count before gamertags. Example: `!challenge start Black Ops 3 Der Eisendrache Difficult 4 Merl,Alex,Sam,Chris`");
        return;
      }

      if (parsed.reason === "map") {
        await message.reply("Please include a map name. Example: `!challenge start Black Ops 3 Der Eisendrache Difficult 4 Merl,Alex,Sam,Chris`");
        return;
      }

      if (parsed.reason === "difficulty") {
        await message.reply("Please include a difficulty. Example: `!challenge start Black Ops 3 Der Eisendrache Difficult 4 Merl,Alex,Sam,Chris`");
        return;
      }

      if (parsed.reason === "tags") {
        await message.reply("Please include gamer tags. Example: `!challenge start Black Ops 3 Der Eisendrache Difficult 4 Merl,Alex,Sam,Chris`");
        return;
      }

      if (parsed.reason === "mismatch") {
        await message.reply(`Player count is ${parsed.playerCount}, but you provided ${parsed.countProvided} gamertag(s).`);
        return;
      }

      await message.reply("Could not parse challenge start command.");
      return;
    }

    const pools = getChallengePools(challengeCatalog, parsed.game, parsed.mapName, parsed.difficulty);

    state.activeChallenge = {
      id: `${Date.now()}`,
      challengeType: "Easter Egg Run",
      game: parsed.game,
      mapName: parsed.mapName,
      difficulty: parsed.difficulty,
      playerCount: parsed.playerCount,
      gamertags: parsed.gamertags,
      globalChallenges: pools.global,
      individualChallenges: pools.individual,
      playerChallenges: parsed.gamertags.map((tag) => ({
        gamertag: tag,
        challengeType: "Easter Egg Run",
        game: parsed.game,
        mapName: parsed.mapName,
        difficulty: parsed.difficulty,
        challenges: pools.individual,
      })),
      createdByUserId: message.author.id,
      createdAtMs: Date.now(),
    };
    saveState(state);

    await message.reply([
      "**Challenge Started**",
      "**Global Challenge**",
      formatChallenge(state.activeChallenge),
      formatChallengeList("Global Challenge Pool", state.activeChallenge.globalChallenges || []),
      formatChallengeList("Individual Challenge Pool", state.activeChallenge.individualChallenges || []),
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

    const finished = {
      ...state.activeChallenge,
      endedAtMs: Date.now(),
      endedByUserId: message.author.id,
    };

    state.history.push(finished);
    state.activeChallenge = null;
    saveState(state);

    await message.reply([
      "**Challenge Ended**",
      "**Global Challenge**",
      formatChallenge(finished),
      formatChallengeList("Global Challenge Pool", finished.globalChallenges || []),
      formatChallengeList("Individual Challenge Pool", finished.individualChallenges || []),
      "**Per-Player Challenges**",
      formatPlayerChallenges(finished),
      `Ended: **${new Date(finished.endedAtMs).toISOString()}**`,
    ].join("\n"));
    return;
  }

  await message.reply("Unknown challenge command. Use `!challenge help`.");
});

client.login(TOKEN);
