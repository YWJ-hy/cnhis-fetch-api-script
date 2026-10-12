#!/usr/bin/env node
import { readFile, copyFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const help = `cnhis-fetch-api <swagger|apifox|init> [options]

  --url <path>       Sync a complete API path (repeatable)
  --config <file>    Configuration relative to project root
  --cwd <directory>  Project root (defaults to current directory)
  --keep-api-json    Keep downloaded API definitions
  --version         Print version
  --help            Print help

Config: fetch-api.config.json, then scripts/fetch-api/settings.json.
Set APIFOX_TOKEN in your environment for authenticated exports.`;

try {
  if (args.includes("--help") || !args.length) {
    console.log(help);
  } else if (args.includes("--version")) {
    console.log(JSON.parse(await readFile(new URL("../package.json", import.meta.url))).version);
  } else {
    const [command, ...flags] = args;
    if (!["swagger", "apifox", "init"].includes(command)) throw new Error(`Unknown command: ${command}`);
    for (let i = 0; i < flags.length; i++) {
      const flag = flags[i];
      if (["--url", "--config", "--cwd"].includes(flag)) {
        if (!flags[i + 1] || flags[i + 1].startsWith("--")) throw new Error(`Missing value for ${flag}`);
        i++;
      } else if (flag !== "--keep-api-json") throw new Error(`Unknown option: ${flag}`);
    }
    if (command === "init") {
      const cwdIndex = flags.indexOf("--cwd");
      const configIndex = flags.indexOf("--config");
      const root = path.resolve(cwdIndex < 0 ? process.cwd() : flags[cwdIndex + 1]);
      const destination = path.resolve(root, configIndex < 0 ? "fetch-api.config.json" : flags[configIndex + 1]);
      await copyFile(new URL("../settings.example.json", import.meta.url), destination, constants.COPYFILE_EXCL);
      console.log(`Created ${destination}`);
    } else {
      await import(`../src/${command}.mjs`);
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
