require("dotenv").config();

const { client } = require("./Timer/timer-script");
const { registerChallengeHandlers } = require("./Challenge/challenge-script");

const token = process.env.DISCORD_TOKEN;

if (!token) {
  console.error("Missing DISCORD_TOKEN in environment.");
  process.exit(1);
}

registerChallengeHandlers(client);
client.login(token);
