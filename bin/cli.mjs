#!/usr/bin/env node
import { readFile, copyFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const help = `cnhis-fetch-api [swagger|apifox|init] [options]

Without a local installation:
  npx --yes --registry=https://registry.npmjs.org cnhis-fetch-api-script@latest <command> [options]
After installing cnhis-fetch-api-script in your project:
  npx cnhis-fetch-api <command> [options]

  --url <path>       Sync a complete API path (repeatable)
  --cwd <directory>  Project root (defaults to current directory)
  --keep-api-json    Keep downloaded API definitions
  --version, -v     Print version
  --help, -h        Print help

Config: fetch-api-setting.json in the project root.
Omit mode to auto-select the configured source, or select with arrow keys and Enter.
Omit --url to enter space-separated URLs interactively.
Set APIFOX_TOKEN in your environment for authenticated exports.`;

try {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(help);
  } else if (args.includes("--version") || args.includes("-v")) {
    console.log(JSON.parse(await readFile(new URL("../package.json", import.meta.url))).version);
  } else {
    const flags = [...args];
    let command = flags[0] && !flags[0].startsWith("-") ? flags.shift() : undefined;
    if (command && !["swagger", "apifox", "init"].includes(command)) throw new Error(`Unknown command: ${command}`);
    for (let i = 0; i < flags.length; i++) {
      const flag = flags[i];
      if (["--url", "--cwd"].includes(flag)) {
        if (!flags[i + 1] || flags[i + 1].startsWith("--")) throw new Error(`Missing value for ${flag}`);
        i++;
      } else if (flag !== "--keep-api-json") throw new Error(`Unknown option: ${flag}`);
    }
    if (command === "init") {
      const cwdIndex = flags.indexOf("--cwd");
      const root = path.resolve(cwdIndex < 0 ? process.cwd() : flags[cwdIndex + 1]);
      const destination = path.join(root, "fetch-api-setting.json");
      await copyFile(new URL("../fetch-api-setting.example.json", import.meta.url), destination, constants.COPYFILE_EXCL);
      console.log(`Created ${destination}`);
    } else {
      const { loadSettings, parseTargetUrls } = await import("../src/shared.mjs");
      const { resolveInteraction } = await import("../src/interaction.mjs");
      const settings = await loadSettings();
      const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
      const prompts = interactive ? await import("@inquirer/prompts") : undefined;
      const selection = await resolveInteraction({
        mode: command, urls: parseTargetUrls(flags), settings, interactive, prompts,
      });
      command = selection.mode;
      if (!flags.includes("--url")) {
        for (const url of selection.urls) process.argv.push("--url", url);
      }
      await import(`../src/${command}.mjs`);
    }
  }
} catch (error) {
  const cancelled = error.name === "ExitPromptError";
  console.error(cancelled ? "已取消" : error.message);
  process.exitCode = cancelled ? 130 : 1;
}
