import { readFile, writeFile, appendFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const releaseDecision = (current, published, changed) => {
  if (published === "0.0.0-stage") {
    throw new Error("npm is still processing the initial publication. Rerun after the stable version is available.");
  }
  if (!published) return { version: current, publish: true };
  const parse = value => {
    if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error(`Unsupported version: ${value}`);
    return value.split(".").map(Number);
  };
  const local = parse(current);
  const remote = parse(published);
  const order = local.reduce((result, value, i) => result || Math.sign(value - remote[i]), 0);
  // A prepared but unpublished release is reused when a failed workflow is rerun.
  if (order > 0) return { version: current, publish: true };
  if (!changed) return { version: published, publish: false };
  return { version: `${remote[0]}.${remote[1]}.${remote[2] + 1}`, publish: true };
};

async function main() {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  let response;
  let published;
  for (let attempt = 0; attempt < 12; attempt++) {
    response = await fetch(`https://registry.npmjs.org/${pkg.name}/latest`);
    if (!response.ok && response.status !== 404) throw new Error(`npm registry: ${response.status}`);
    published = response.status === 404 ? null : await response.json();
    if (published?.version !== "0.0.0-stage") break;
    console.log("Waiting for npm to finish the initial publication...");
    await new Promise(resolve => setTimeout(resolve, 10000));
  }
  let changed = true;
  if (published?.gitHead) {
    // Failure to resolve a published commit must fail loudly, never silently skip a release.
    const diff = execFileSync("git", ["diff", "--name-only", published.gitHead, "HEAD", "--",
      "src", "bin", "fetch-api-setting.example.json", "package.json", "package-lock.json"], { encoding: "utf8" });
    changed = Boolean(diff.trim());
  }
  const decision = releaseDecision(pkg.version, published?.version, changed);
  if (decision.version !== pkg.version && decision.publish) {
    pkg.version = decision.version;
    await writeFile("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
    const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
    lock.version = decision.version;
    lock.packages[""].version = decision.version;
    await writeFile("package-lock.json", `${JSON.stringify(lock, null, 2)}\n`);
  }
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `publish=${decision.publish}\nversion=${decision.version}\n`);
  }
  console.log(JSON.stringify(decision));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
