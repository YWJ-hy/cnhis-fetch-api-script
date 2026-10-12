import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);
const scriptDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const requestOptions = {
  enabled: true,
  params: [
    { name: "config", type: "AxiosRequestConfig" },
    { name: "otherConfig", type: "OtherConfig" },
  ],
};
const operation = (type = "string") => ({
  parameters: [{ in: "query", name: "id", type: "integer", format: "int32", required: true }],
  responses: { 200: { schema: { type: "object", properties: { data: { type } } } } },
});

// 每次测试复制脚本至独立临时项目；fetch 在子进程中替换，不访问真实服务或业务文件。
const fixture = async (t, settings = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fetch-api-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, "scripts/fetch-api");
  await fs.mkdir(dir, { recursive: true });
  for (const name of ["shared.mjs", "types-gen.mjs", "swagger.mjs", "apifox.mjs"]) {
    await fs.copyFile(path.join(scriptDir, name), path.join(dir, name));
  }
  let config = {
    serviceDir: "generated",
    httpImport: "@/http",
    formatter: "node --version",
    swagger: { url: "https://fixture.invalid/swagger", module: "alpha" },
    apifox: {
      url: "https://fixture.invalid/export",
      token: "fixture-token",
      selectedFolderIds: [1, 2],
    },
    ...settings,
  };
  await fs.writeFile(
    path.join(root, "mock.mjs"),
    `
    import { readFileSync, writeFileSync } from "node:fs";
    const replies = JSON.parse(readFileSync("replies.json", "utf8"));
    const requests = [];
    globalThis.fetch = async (url, options) => {
      requests.push({ url, ...options });
      writeFileSync("requests.json", JSON.stringify(requests));
      const reply = replies[requests.length - 1];
      if (!reply) throw new Error("Unexpected fetch");
      return { ok: !reply.failure, status: 503, statusText: "Unavailable", json: async () => reply };
    };
  `,
  );
  return {
    root,
    read: name => fs.readFile(path.join(root, name), "utf8"),
    write: (name, value) => fs.writeFile(path.join(root, name), value),
    async run(source, replies, args = [], patch = {}) {
      config = { ...config, ...patch };
      await fs.writeFile(
        path.join(dir, "settings.json"),
        `// JSONC config\n${JSON.stringify(config)}`,
      );
      await fs.writeFile(path.join(root, "replies.json"), JSON.stringify(replies));
      await fs.writeFile(path.join(root, "requests.json"), "[]");
      return execFileAsync(
        process.execPath,
        ["--import", "./mock.mjs", `scripts/fetch-api/${source}.mjs`, ...args],
        {
          cwd: root,
          env: { ...process.env, SWAGGER_URL: "", APIFOX_URL: "", APIFOX_TOKEN: "" },
        },
      );
    },
  };
};

test("legacy Apifox folder array keeps paths and forwards request options with and without params", async t => {
  const f = await fixture(t, { requestOptions });
  await f.run(
    "apifox",
    [{ paths: { "/alpha/items/query": { get: operation(), post: { responses: {} } } } }],
    ["--keep-api-json"],
  );
  const requests = JSON.parse(await f.read("requests.json"));
  assert.deepEqual(JSON.parse(requests[0].body).scope.selectedFolderIds, [1, 2]);
  assert.equal(requests[0].headers.Authorization, "Bearer fixture-token");
  const index = await f.read("generated/alpha/items/index.ts");
  assert.match(
    index,
    /params: QueryGetParams, config\?: AxiosRequestConfig, otherConfig\?: OtherConfig/,
  );
  assert.match(
    index,
    /http.get<QueryGetResult>\("\/alpha\/items\/query", params, config, otherConfig\)/,
  );
  assert.match(
    index,
    /QueryPost = async \(config\?: AxiosRequestConfig, otherConfig\?: OtherConfig\)/,
  );
  assert.match(index, /undefined, config, otherConfig/);
  assert.deepEqual(Object.keys(JSON.parse(await f.read("api.json")).paths), ["/alpha/items/query"]);
});

test("grouped Apifox prefixes paths, isolates same-name definitions and strips fixed contexts", async t => {
  const f = await fixture(t, {
    contextFixed: true,
    apifox: {
      url: "https://fixture.invalid",
      token: "test",
      selectedFolderIds: { alpha: [1], beta: [2] },
    },
  });
  const doc = (url, type) => ({
    paths: {
      [url]: { get: { responses: { 200: { schema: { $ref: "#/definitions/Response" } } } } },
    },
    definitions: {
      Response: { type: "object", properties: { data: { $ref: "#/definitions/Value" } } },
      Value: { type },
    },
  });
  await f.run("apifox", [doc("/items/first", "string"), doc("/beta/items/second", "number")]);
  const types = await f.read("generated/items/types.d.ts");
  assert.match(types, /FirstGetResult = string/);
  assert.match(types, /SecondGetResult = number/);
  assert.match(await f.read("generated/items/index.ts"), /"\/beta\/items\/second"/);
  await assert.rejects(f.read("api.json"), { code: "ENOENT" });
});

test("grouped Apifox stops once every target is found, including Git Bash URL normalization", async t => {
  const f = await fixture(t, {
    apifox: {
      url: "https://fixture.invalid",
      token: "test",
      selectedFolderIds: { alpha: [1], beta: [2], gamma: [3] },
    },
  });
  await f.run(
    "apifox",
    [
      { paths: { "/items/first": { get: operation() } } },
      { paths: { "/items/second": { get: operation() } } },
    ],
    ["--url", "C:/Program Files/Git/alpha/items/first", "--url", "/beta/items/second"],
  );
  assert.equal(JSON.parse(await f.read("requests.json")).length, 2);
  assert.match(await f.read("generated/alpha/items/index.ts"), /FirstGet/);
  assert.match(await f.read("generated/beta/items/index.ts"), /SecondGet/);
});

test("ignorePaths protects old function names and types while allowing new endpoints and request options", async t => {
  const url = "/alpha/items/nested/query";
  const f = await fixture(t, { ignorePaths: [url], requestOptions });
  const doc = { paths: { [url]: { get: operation() } } };
  await f.run("swagger", [doc]);
  const originalIndex = (await f.read("generated/alpha/items/index.ts")).replaceAll(
    "NestedQueryGet",
    "CustomGet",
  );
  const originalTypes = (await f.read("generated/alpha/items/types.d.ts")).replaceAll(
    "NestedQueryGet",
    "CustomGet",
  );
  await f.write("generated/alpha/items/index.ts", originalIndex);
  await f.write("generated/alpha/items/types.d.ts", originalTypes);
  const changed = { paths: { [url]: { get: operation("number") } } };
  await f.run("swagger", [changed], ["--url", url]);
  assert.equal(await f.read("generated/alpha/items/index.ts"), originalIndex);
  assert.equal(await f.read("generated/alpha/items/types.d.ts"), originalTypes);
  await f.run("swagger", [
    { paths: { ...changed.paths, "/alpha/items/create": { post: operation() } } },
  ]);
  const index = await f.read("generated/alpha/items/index.ts");
  assert.match(index, /CustomGet/);
  assert.doesNotMatch(index, /NestedQueryGet/);
  assert.match(index, /CreatePost/);
  assert.match(await f.read("generated/alpha/items/types.d.ts"), /CustomGetResult = string/);
});

test("Swagger context settings support both configuration shapes; GET/POST remain distinct and stable", async t => {
  for (const context of [{ contextFixed: true }, { context: { fixed: true, module: "alpha" } }]) {
    const f = await fixture(t, {
      ...context,
      ...(context.context ? { swagger: { url: "https://fixture.invalid/swagger" } } : {}),
    });
    const doc = {
      paths: { "/alpha/items/query": { get: operation(), post: operation(), delete: operation() } },
    };
    await f.run("swagger", [doc]);
    const index = await f.read("generated/items/index.ts");
    assert.match(index, /QueryGet/);
    assert.match(index, /QueryPost/);
    assert.doesNotMatch(index, /QueryDelete|AxiosRequestConfig/);
    const result = await f.run("swagger", [doc]);
    assert.match(result.stdout, /无任何更新/);
    assert.equal(await f.read("generated/items/index.ts"), index);
    await f.run("swagger", [
      { paths: { "/alpha/items/query": { get: operation("number"), post: operation() } } },
    ]);
    assert.match(await f.read("generated/items/types.d.ts"), /QueryGetResult = number/);
  }
});

test("request options can be enabled for existing functions and repeated sync is stable", async t => {
  const f = await fixture(t);
  const doc = { paths: { "/alpha/items/query": { get: operation() } } };
  await f.run("swagger", [doc]);
  await f.run("swagger", [doc], [], { requestOptions });
  const index = await f.read("generated/alpha/items/index.ts");
  assert.match(index, /params, config, otherConfig/);
  await f.run("swagger", [doc]);
  assert.equal(await f.read("generated/alpha/items/index.ts"), index);
  await f.run("swagger", [doc], ["--url", "/alpha/items/query"], {
    requestOptions: { enabled: false },
  });
  const disabled = await f.read("generated/alpha/items/index.ts");
  assert.doesNotMatch(disabled, /config\?:|params, config/);
});

test("URL requirements, unmatched URL cleanup and fetch failures", async t => {
  const f = await fixture(t, { urlRequired: true });
  await assert.rejects(f.run("swagger", []), /必须通过 --url/);
  assert.deepEqual(JSON.parse(await f.read("requests.json")), []);
  await f.run("swagger", [{ paths: {} }], ["--url", "/missing"]);
  await assert.rejects(f.read("api.json"), { code: "ENOENT" });
  await assert.rejects(
    f.run("apifox", [{ failure: true }], ["--url", "/missing"]),
    /503 Unavailable/,
  );
});
