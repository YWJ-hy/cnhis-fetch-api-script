# cnhis-fetch-api-script

从 Swagger 或 Apifox 获取接口定义，按模块生成 TypeScript 请求函数和类型声明。

## 安装与迁移

```sh
npm install -D cnhis-fetch-api-script --registry=https://registry.npmjs.org
npx cnhis-fetch-api init
```

新项目编辑 `fetch-api.config.json`；已有项目可以直接沿用 `scripts/fetch-api/settings.json`，无需运行 init。优先读取根目录的 `fetch-api.config.json`，也可使用 `--config <file>` 指定配置。配置不存在或格式错误时退出，避免误生成。Apifox token 建议使用 `APIFOX_TOKEN` 环境变量，真实业务配置不包含在 npm 包中。

运行环境为 Node.js 22 或更高版本，无运行时依赖。目标项目需提供 `httpImport` 指定的默认导出（包含 `get` / `post` 方法，返回 `{ success, data }`）、全局 `Nullable<T>` 和 `ObjectType` 类型，以及 `formatter` 指定的格式化工具。

## 使用

在项目根目录运行（使用项目要求的 Node.js 版本）：

```sh
npx cnhis-fetch-api swagger --url /catalog/items/query
npx cnhis-fetch-api apifox --url /catalog/items/query --url /catalog/items/save
npx cnhis-fetch-api apifox --url /catalog/items/query --keep-api-json
npx cnhis-fetch-api swagger --cwd ../another-project --config config/api.json
```

输出、`api.json`、格式化命令的工作目录均相对于调用项目根目录（默认当前工作目录，或 `--cwd`），不会写入 node_modules。`--config` 相对于该项目根目录。可在使用项目的 package.json 中配置 `"api:apifox": "cnhis-fetch-api apifox"`。

迁移完成后，原 `scripts/fetch-api` 可只保留 `settings.json`，工具源码统一在本仓库维护。

`urlRequired: true` 时，必须指定至少一个完整接口路径。设为 `false` 或省略时，不传 `--url` 即同步全部接口；传入 URL 时仅更新匹配接口。Git Bash 自动转换成 `C:/Program Files/Git/...` 的路径会还原。

同步生成 `serviceDir` 下的 `index.ts` 和 `types.d.ts`，然后调用 `formatter` 格式化目录。新接口追加，已有接口按名称更新，命名规则变化时按请求方法和 URL 迁移旧函数与类型。全量模式通常仅更新类型变化的接口；启用 `requestOptions` 时也更新已有函数以补齐参数。`--url` 强制更新所选接口，仍遵守 `ignorePaths`。

## 配置

`settings.json` 支持注释。`SWAGGER_URL`、`APIFOX_URL`、`APIFOX_TOKEN` 环境变量优先于文件中的对应值。下文地址、路径和 ID 均为示例，应按目标项目替换。

### Apifox 文件夹

数组模式：单次导出，不补路径前缀。

```json
{ "selectedFolderIds": [10001, 10002] }
```

分组模式：按顺序逐组导出，以键名补全路径上下文。已经带有相同前缀的路径不会重复拼接。

```json
{
  "selectedFolderIds": {
    "catalog": [10001],
    "orders": [10002]
  }
}
```

例如 `catalog` 组导出的 `/items/query` 对应 `/catalog/items/query`。指定 `--url` 后，找到全部目标路径就停止后续组请求；保留的 `api.json` 也仅包含已请求的组。各组 definitions 会增加内部前缀并同步改写引用，避免同名模型相互覆盖。`environmentIds` 指定导出环境 ID 列表，`apiVersion` 指定 Apifox API 版本。导出使用 Swagger 2.0 JSON，不包含 Apifox 扩展属性，也不将文件夹添加到 tags。

### 上下文与模块目录

- `contextFixed: false`：前两段路径作为目录，如 `/catalog/items/query` → `catalog/items`。
- `contextFixed: true`：剥离匹配的上下文，以上路径 → `items`。Swagger 使用 `swagger.module`（字符串或数组），Apifox 分组模式使用 `selectedFolderIds` 的键。
- 兼容旧字段 `context.fixed` / `context.module`；`contextFixed` 优先，旧 `context.module` 在来源未配置模块时作为后备。旧字段不负责给 Apifox 数组模式补路径。

模块后全部路径段拼接为函数名，并加请求方法后缀，如 `/catalog/items/detail/query` → `DetailQueryGet`。

### 覆盖保护和请求参数

```json
{
  "ignorePaths": ["/catalog/items/custom-query"],
  "requestOptions": {
    "enabled": true,
    "typeImport": "@/utils/http",
    "params": [
      { "name": "config", "type": "AxiosRequestConfig" },
      { "name": "otherConfig", "type": "OtherConfig" }
    ]
  }
}
```

`ignorePaths` 精确匹配完整 URL：已有接口的函数和类型不更新、不重命名；尚未生成的接口仍新增。同一 URL 的不同请求方法分别识别。格式化器仍可能调整文件排版。

启用 `requestOptions` 后，生成的函数接收可选配置，并按顺序透传至 `http.get/post(url, params, config, otherConfig)`。没有业务入参时第二个 HTTP 参数为 `undefined`。类型应为指定模块导出的类型名称。不需要额外参数时可关闭或省略该配置；关闭后要立即移除已有函数上的透传参数，可用 `--url` 更新对应接口。

## 类型生成与支持范围

支持 Swagger definitions / OpenAPI components.schemas 引用、对象、数组、枚举、字典、组合类型、可选字段 `Nullable`、嵌套 namespace、响应 `data` 提取，以及入参 `map` / `userRoleResource` 过滤。递归引用在循环处停止展开，同级重复引用独立展开。整数无 format 或 format 为 int32 时生成 number，其他非空 format 生成 string。

只生成 GET/POST，其他请求方法跳过并记录日志。解析以 Swagger 2 为主：部分 OpenAPI 3 响应和 schema 可解析，但不代表完整支持 OpenAPI 3 requestBody、路径参数插值或文件上传。

## 验证

回归测试在临时项目中模拟 fetch，验证数组/分组导出、前缀、同名 DTO、提前停止、上下文配置兼容、覆盖保护、请求参数启用和关闭状态、增量更新、重复同步、URL 参数与失败路径。没有请求真实 Swagger/Apifox，也不会覆盖实际业务 service 文件。

```sh
npm ci
npm test
npm pack --dry-run
```

## 自动版本与 npm 发布

推送到 `main` 且修改 `src/**`、`bin/**`、`settings.example.json`、`package.json` 或 `package-lock.json` 时，`.github/workflows/release.yml` 自动执行测试，对照 npm 已发布版本与 gitHead 检测变化，递增 patch 版本，将版本提交推回 main，发布 npm 并创建版本标签。无需特定提交前缀；功能修改也默认递增 patch。需要 minor/major 时，提前修改 package.json 及 package-lock.json 的版本。

发布串行执行，不取消正在进行的发布。机器人版本提交使用 GITHUB_TOKEN，不会再次触发 workflow。发布前 push 遇到并发提交时失败，不强推；重新运行 workflow 会使用最新 main。npm 发布失败时可重跑，复用已准备的版本；发布成功但标签步骤失败时，手动运行 workflow 会补齐标签。仅文档/测试修改不发布；可从 Actions 手动运行 Release npm 进行恢复。

使用 npm Trusted Publishing（GitHub Actions OIDC），工作流拥有 `id-token: write`，不存储长期 NPM_TOKEN，发布附带 provenance。首次创建新包需由维护者本地登录后发布，再绑定：

```sh
npm publish
npm trust github cnhis-fetch-api-script --repo YWJ-hy/cnhis-fetch-api-script --file release.yml --allow-publish --yes
```

绑定需要 npm 11.15+ 和账户 2FA 验证。仓库必须允许 GitHub Actions 推送 main 和标签；若未来启用分支保护，请保留发布机器人的相应权限。CI 在 Windows/Linux、Node.js 22/24 上验证测试与打包。
