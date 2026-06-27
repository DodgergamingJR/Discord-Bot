# Fishy Fish Bot

A Discord bot to help with Zombie Activities that:
- counts up in `HH:MM:SS` (and shows days when needed)
- supports start, stop, resume, reset
- can be backdated (for example, started 2 days ago)

## 1) Create the bot in Discord Developer Portal

1. Go to https://discord.com/developers/applications
2. Create a new application.
3. Go to **Bot** and click **Add Bot**.
4. Under Privileged Gateway Intents, enable:
   - **Message Content Intent**
5. Copy the bot token.

## 2) Configure project

1. Install Node.js 26+.
2. In this folder, run:

```bash
npm install
```

3. Create `.env` from `.env.example` and set:

```env
DISCORD_TOKEN=your_real_token_here
```

## 3) Invite bot to your server

In Developer Portal:
1. Go to **OAuth2 > URL Generator**.
2. Scopes: `bot`
3. Bot permissions: `Send Messages`, `Read Message History`, `View Channels`
4. Open generated URL and invite the bot.

## 4) Run

```bash
npm start
```

## 5) Run multiple custom scripts

You can add standalone scripts to the `scripts/` folder and run them without changing `package.json` each time.

```bash
npm run script -- <script-name>
```

Example:

```bash
npm run script -- example
```

## Commands

- `!timer` or `!timer status`
- `!timer help`
- `!timer start`
- `!timer start 2d4h30m10s`
- `!timer startat 2026-06-25T12:00:00Z`
- `!timer stop`
- `!timer resume`
- `!timer reset`

## Examples

- Start from zero:
  - `!timer start`
- Start as if it began 2 days ago:
  - `!timer start 2d`
- Start from exact past timestamp:
  - `!timer startat 2026-06-25T09:00:00Z`

The timer state is saved in `timer-state.json`, so it persists across bot restarts.
