require("dotenv").config();

const { client, backupTablesSnapshot, scheduleNightlyTableBackup } = require("./Timer/timer-script");
const { registerChallengeHandlers, backupChallengeTablesSnapshot, scheduleNightlyChallengeTableBackup } = require("./Challenge/challenge-script");

const token = process.env.DISCORD_TOKEN;

if (!token) {
  console.error("Missing DISCORD_TOKEN in environment.");
  process.exit(1);
}

backupTablesSnapshot();
scheduleNightlyTableBackup();

backupChallengeTablesSnapshot();
scheduleNightlyChallengeTableBackup();

registerChallengeHandlers(client);
client.login(token);
