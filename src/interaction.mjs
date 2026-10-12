export const modeQuestion = modes => ({
  message: "请选择接口来源（上下键选择，Enter 确认）",
  choices: modes.map(value => ({ name: value === "swagger" ? "Swagger" : "Apifox", value })),
});

export const urlQuestion = required => ({
  message: "请输入url，多个url空格间隔",
  validate: value => !required || Boolean(value.trim()) || "请至少输入一个 URL",
});

export async function resolveInteraction({ mode, urls, settings, interactive, prompts }) {
  const modes = ["swagger", "apifox"].filter(name =>
    typeof settings[name]?.url === "string" && settings[name].url.trim(),
  );
  if (mode && !modes.includes(mode)) throw new Error(`未配置 ${mode}.url，请检查 fetch-api-setting.json 或环境变量`);
  if (!mode) {
    if (!modes.length) throw new Error("请在 fetch-api-setting.json 中配置 swagger.url 或 apifox.url");
    if (modes.length === 1) mode = modes[0];
    else {
      if (!interactive) throw new Error("非交互环境请指定模式 swagger 或 apifox");
      mode = await prompts.select(modeQuestion(modes));
    }
  }
  if (!urls.length) {
    if (!interactive) throw new Error("非交互环境请通过 --url 指定接口路径");
    const value = await prompts.input(urlQuestion(Boolean(settings.urlRequired)));
    urls = value.trim().split(/\s+/).filter(Boolean);
  }
  return { mode, urls };
}
