# Fishy Fish Bot

A Discord bot for Zombies sessions with two core systems:

1. `!timer` commands for run timing, backdating, and timer tables.
2. `!challenge` commands for map/difficulty challenge generation and challenge tables.

## Setup

### 1) Create the bot in Discord Developer Portal

1. Go to https://discord.com/developers/applications
2. Create a new application.
3. Go to **Bot** and click **Add Bot**.
4. Enable **Message Content Intent**.
5. Copy the bot token.

### 2) Install and configure

1. Install Node.js `26+`.
2. Install dependencies:

```bash
npm install
```

3. Create `.env` and add:

```env
DISCORD_TOKEN=
```

### 3) Invite bot to your server

In Developer Portal:

1. Go to **OAuth2 > URL Generator**.
2. Scopes: `bot`
3. Permissions: `Send Messages`, `Read Message History`, `View Channels`
4. Open URL and invite.

## Run Modes

### Main bot (timer + challenge together)

```bash
npm start
```

Dev watch mode:

```bash
npm run dev
```

Windows auto-restart loop (bat):

```bash
run-the-z-crew-discord-bot.bat
```

Or via npm:

```bash
npm run start:bat
```

### Standalone scripts

```bash
npm run timer-script
npm run challenge-script
```

Optional script launcher:

```bash
npm run script -- timer-script
npm run script -- challenge-script
```

## Bot Architecture

1. `Main.js` is the master entrypoint.
2. `Timer/timer-script.js` owns timer logic and timer commands.
3. `Challenge/challenge-script.js` registers challenge handlers on the same Discord client.
4. Main startup initializes both timer and challenge backup schedulers.

## Timer Commands

Use `!timer help` in Discord for the latest in-bot list.

- `!timer` or `!timer status`
- `!timer name <map name>`
- `!timer clearname`
- `!timer start <name>`
- `!timer start <duration> <name>`
- `!timer startat <dd-mm-yyyy hh:mm:ss> <name>`
- `!timer stop`
- `!timer stop <name>`
- `!timer resume`
- `!timer reset`

### Timer table commands

- `!timer create table <name>`
- `!timer add table <name>`
- `!timer table show <name>`
- `!timer table show all`
- `!timer table stats <name>`
- `!timer table rename <old> <new>`
- `!timer table remove <name> <last|index>`
- `!timer table delete <name>`
- `!timer backup now`

## Challenge Commands

Use `!challenge help` in Discord for the latest in-bot list.

- `!challenge games`
- `!challenge start <game> <map> <difficulty> <globalChallengeCount> <individualChallengeCount> <gamertag1,gamertag2,...>`
- `!challenge status`
- `!challenge end <Completed|Failed>`

### Challenge table commands

- `!challenge create table <name>`
- `!challenge add table <name>`
- `!challenge table show <name>`
- `!challenge table show all`
- `!challenge table stats <name>`
- `!challenge table rename <old> <new>`
- `!challenge table remove <name> <last|index>`
- `!challenge table delete <name>`
- `!challenge backup now`

When a challenge is ended, the bot prompts where to add it to a challenge table.

## Data Files

### Timer

- `Timer/timer-state.json`
- `Timer/timer-tables.json`

### Challenge

- `Challenge/challenge-state.json`
- `Challenge/challenge-tables.json`
- `Challenge/challenge-catalog.json`
- `Challenge/games.json`

## Backups

Automatic and manual table backups are stored under:

- `backups/Table Backups/Timer`
- `backups/Table Backups/Challenge`

Backup snapshots are date-based JSON files.
