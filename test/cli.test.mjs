import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const packageRoot = fileURLToPath(new URL("../", import.meta.url));

test("installed CLI reads consumer config and writes into --cwd, never its installation", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fetch-api-cli-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const installation = path.join(root, "node_modules/cnhis-fetch-api-script");
  await fs.mkdir(installation, { recursive: true });
  for (const entry of ["src", "bin", "package.json", "fetch-api-setting.example.json"]) {
    await fs.cp(path.join(packageRoot, entry), path.join(installation, entry), { recursive: true });
  }
  const project = path.join(root, "consumer");
  await fs.mkdir(project);
  const cli = path.join(installation, "bin/cli.mjs");
  const run = (...args) => exec(process.execPath, [cli, ...args], { cwd: root });
  assert.match((await run("--help")).stdout, /fetch-api-setting.json/);
  assert.match((await run("--version")).stdout, /^\d+\.\d+\.\d+/);
  assert.equal((await run("-v")).stdout, (await run("--version")).stdout);
  assert.equal((await run("-h")).stdout, (await run("--help")).stdout);
  await assert.rejects(run("swagger", "--cwd"), /Missing value/);
  await assert.rejects(run("swagger", "--config", "custom.json"), /Unknown option/);
  await assert.rejects(run("swagger", "--unexpected"), /Unknown option/);
  await run("init", "--cwd", project);
  await assert.rejects(run("init", "--cwd", project), /EEXIST/);
  // The generated, fully commented sample must parse and reach CLI validation.
  await assert.rejects(run("swagger", "--cwd", project), /非交互环境请通过 --url/);
  const config = {
    swagger: { url: "https://fixture.invalid" },
    serviceDir: "generated", formatter: "node --version",
  };
  await fs.writeFile(path.join(project, "fetch-api-setting.json"), JSON.stringify(config));
  const mock = path.join(root, "mock.mjs");
  await fs.writeFile(mock, `globalThis.fetch = async () => ({ok:true,json:async()=>({paths:{"/alpha/items/query":{get:{responses:{200:{schema:{type:"string"}}}}}}})});`);
  await exec(process.execPath, ["--import", pathToFileURL(mock).href, cli, "--cwd", project, "--url", "/alpha/items/query"], {
    cwd: root, env: { ...process.env, SWAGGER_URL: "" },
  });
  assert.match(await fs.readFile(path.join(project, "generated/alpha/items/index.ts"), "utf8"), /QueryGet/);
  await assert.rejects(fs.access(path.join(installation, "generated")), { code: "ENOENT" });
  await fs.rename(path.join(project, "fetch-api-setting.json"), path.join(project, "fetch-api.config.json"));
  await fs.mkdir(path.join(project, "scripts/fetch-api"), { recursive: true });
  await fs.writeFile(path.join(project, "scripts/fetch-api/settings.json"), JSON.stringify(config));
  await assert.rejects(run("swagger", "--cwd", project), /读取配置失败/);
  await fs.writeFile(path.join(project, "fetch-api-setting.json"), "{ invalid");
  await assert.rejects(run("swagger", "--cwd", project), /读取配置失败/);
});
