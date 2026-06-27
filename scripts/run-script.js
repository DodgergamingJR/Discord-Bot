const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");

const input = process.argv[2] || "timer-script";
const extraArgs = process.argv.slice(3);

const normalizedName = input.endsWith(".js") ? input : `${input}.js`;
const targetPath = path.resolve(process.cwd(), "scripts", normalizedName);

if (!existsSync(targetPath)) {
  console.error(`Script not found: ${targetPath}`);
  console.error("Create the file under ./scripts and run again.");
  process.exit(1);
}

const child = spawn(process.execPath, [targetPath, ...extraArgs], {
  stdio: "inherit",
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});
