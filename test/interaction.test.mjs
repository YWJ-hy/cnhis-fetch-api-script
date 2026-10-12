import test from "node:test";
import assert from "node:assert/strict";
import { render } from "@inquirer/testing";
import { select, input } from "@inquirer/prompts";
import { resolveInteraction, modeQuestion, urlQuestion } from "../src/interaction.mjs";

test("source selection and missing URL prompting follow configuration", async () => {
  const both = { swagger: { url: "https://swagger.invalid" }, apifox: { url: "https://apifox.invalid" } };
  for (const mode of ["swagger", "apifox"]) {
    const result = await resolveInteraction({ settings: { [mode]: both[mode] }, urls: [], interactive: true,
      prompts: { input: async question => {
        assert.equal(question.message, "请输入url，多个url空格间隔");
        return " /a/first   /b/second  ";
      }, select: () => assert.fail("Only one mode, no selection needed") },
    });
    assert.deepEqual(result, { mode, urls: ["/a/first", "/b/second"] });
  }
  const result = await resolveInteraction({ settings: both, urls: ["/a"], interactive: true,
    prompts: { select: async () => "apifox", input: () => assert.fail("URL already supplied") },
  });
  assert.equal(result.mode, "apifox");
  assert.deepEqual(await resolveInteraction({ settings: both, mode: "swagger", urls: ["/a"], interactive: false }),
    { mode: "swagger", urls: ["/a"] });
  await assert.rejects(resolveInteraction({ settings: both, urls: ["/a"], interactive: false }), /指定模式/);
  await assert.rejects(resolveInteraction({ settings: both, mode: "swagger", urls: [], interactive: false }), /--url/);
  await assert.rejects(resolveInteraction({ settings: {}, urls: [], interactive: true }), /配置 swagger.url/);
  await assert.rejects(resolveInteraction({ settings: { swagger: both.swagger }, mode: "apifox", urls: ["/a"] }), /apifox.url/);
});

test("real selector handles down/up and Enter", async () => {
  const first = await render(select, modeQuestion(["swagger", "apifox"]));
  first.events.keypress("down");
  first.events.keypress("enter");
  assert.equal(await first.answer, "apifox");
  const second = await render(select, modeQuestion(["swagger", "apifox"]));
  second.events.keypress("down");
  second.events.keypress("up");
  second.events.keypress("enter");
  assert.equal(await second.answer, "swagger");
});

test("real URL input rejects required empty input, then accepts multiple URLs", async () => {
  const prompt = await render(input, urlQuestion(true));
  prompt.events.keypress("enter");
  await prompt.nextRender();
  assert.match(prompt.getScreen(), /请至少输入一个 URL/);
  prompt.events.type("/a /b");
  prompt.events.keypress("enter");
  assert.equal(await prompt.answer, "/a /b");
  const optional = await render(input, urlQuestion(false));
  optional.events.keypress("enter");
  assert.equal(await optional.answer, "");
});

test("Ctrl+C cancels selection", async () => {
  const prompt = await render(select, modeQuestion(["swagger", "apifox"]));
  const rejected = assert.rejects(prompt.answer, { name: "ExitPromptError" });
  prompt.events.keypress({ name: "c", ctrl: true });
  await rejected;
});
