# cnhis-fetch-api-script

从 Swagger 或 Apifox 获取接口定义，按模块生成 TypeScript 请求函数和类型声明。

## 运行方式

包名为 `cnhis-fetch-api-script`，安装后提供的命令名为 `cnhis-fetch-api`。以下两种方式任选其一。

### 不安装到项目依赖

在使用方项目根目录执行：

```sh
npx --yes --registry=https://registry.npmjs.org cnhis-fetch-api-script@latest init
npx --yes --registry=https://registry.npmjs.org cnhis-fetch-api-script@latest apifox --url /catalog/items/query
```

`npx` 将包下载到 npm 缓存并执行，不会添加到项目的 package.json。`@latest` 选择最新版本；需要固定版本时替换为具体版本号。未安装时请使用包名 `cnhis-fetch-api-script`，不要使用 `npx cnhis-fetch-api`，否则 npm 会尝试查找另一个同名包。

### 安装到项目依赖

```sh
npm install -D cnhis-fetch-api-script --registry=https://registry.npmjs.org
npx cnhis-fetch-api init
```

`init` 在使用方项目根目录创建固定名称的 `fetch-api-setting.json`，包含每个配置项的用途和默认值；已有文件不会覆盖。也可复制仓库中的 [完整注释样例](./fetch-api-setting.example.json) 并改为该文件名。配置不存在或格式错误时退出。Apifox token 可使用 `APIFOX_TOKEN` 环境变量提供。

运行环境为 Node.js 22.13+（22 系列）或 24+，交互使用 Inquirer。目标项目需提供 `httpImport` 指定的默认导出（包含 `get` / `post` 方法，返回 `{ success, data, msg }`）、全局 `Nullable<T>` 和 `ObjectType` 类型，以及 `formatter` 指定的格式化工具。

## 使用

以下简写命令要求先按上文安装到项目依赖中。在项目根目录运行：

```sh
npx cnhis-fetch-api
npx cnhis-fetch-api swagger --url /catalog/items/query
npx cnhis-fetch-api apifox --url /catalog/items/query --url /catalog/items/save
npx cnhis-fetch-api apifox --url /catalog/items/query --keep-api-json
npx cnhis-fetch-api swagger --cwd ../another-project --url /catalog/items/query
```

若未安装到项目依赖，将上述命令中的 `npx cnhis-fetch-api` 替换为 `npx --yes --registry=https://registry.npmjs.org cnhis-fetch-api-script@latest`，其余子命令和参数保持一致。

不传模式时，按照合并环境变量后的配置判断来源：只有 `swagger.url` 或 `apifox.url` 非空时自动选择对应来源；两者都有时显示选择菜单，使用上下键切换、Enter 确认。显式传入 `swagger` 或 `apifox` 时跳过菜单。来源选择按地址判断，Apifox 认证令牌等要求仍会在执行时检查。

未传 `--url` 时显示“请输入url，多个url空格间隔”，输入完整路径后 Enter 继续，例如 `/catalog/items/query /catalog/items/save`。`urlRequired: true` 时空输入会要求重新输入；为 `false` 时空 Enter 表示全量同步。Ctrl+C 取消执行。CI 等非交互环境不会等待输入，需明确提供 `--url`，配置两个来源时还需指定模式。`init`、`--help`、`--version` 不触发此交互。

默认把当前工作目录作为项目根目录，请在使用方项目根目录执行；从其他位置执行时使用 `--cwd` 指定项目根目录。配置只读取该目录的 `fetch-api-setting.json`，文件名不可通过参数更改。输出、`api.json`、格式化命令的工作目录也基于该项目根目录。可在使用项目的 package.json 中配置 `"api:apifox": "cnhis-fetch-api apifox"`。

从早期版本迁移时，将原配置内容保存到项目根目录的 `fetch-api-setting.json`；旧 `fetch-api.config.json`、`scripts/fetch-api/settings.json` 和 `--config` 不再支持。

| 命令或参数 | 功能 |
| --- | --- |
| `init` | 创建带注释的配置文件，已有文件时退出 |
| `swagger` | 下载 Swagger JSON 并生成请求函数及类型 |
| `apifox` | 导出 Apifox 接口并生成请求函数及类型 |
| `--url <path>` | 按完整路径选择接口，可重复传入多个；同路径 GET/POST 都会处理 |
| `--cwd <directory>` | 指定使用项目根目录，默认当前工作目录 |
| `--keep-api-json` | 保留下载到项目根目录的 api.json，默认同步结束后删除 |
| `--help` / `-h` | 显示命令帮助 |
| `--version` / `-v` | 显示已安装版本 |

`urlRequired: true` 时，必须通过参数或交互输入至少一个完整接口路径。设为 `false` 或省略时，可在交互提示中直接按 Enter 同步全部接口；输入 URL 时仅更新匹配接口。Git Bash 自动转换成 `C:/Program Files/Git/...` 的路径会还原。

同步生成 `serviceDir` 下的 `index.ts` 和 `types.d.ts`，然后调用 `formatter` 格式化目录。新接口追加，已有接口按名称更新，命名规则变化时按请求方法和 URL 迁移旧函数与类型。全量模式通常仅更新类型变化的接口；启用 `requestOptions` 时也更新已有函数以补齐参数。`--url` 强制更新所选接口，仍遵守 `ignorePaths`。

## 配置

`fetch-api-setting.json` 支持 `//`、`/* */` 注释，不支持尾随逗号。下表中的默认值是省略配置时的行为；样例可能使用不同值来展示用法。所有地址、模块路径和 ID 均为示例，应按使用项目替换。

| 配置项 | 类型 / 默认值 | 功能与使用条件 |
| --- | --- | --- |
| `contextFixed` | boolean / `false` | 是否剥离已配置的 URL 上下文来决定输出目录；优先于 `context.fixed` |
| `httpImport` | string / `@/common/utils/http` | 生成函数使用的 HTTP 默认导出模块路径 |
| `serviceDir` | string / `src/service2` | 相对于项目根目录的输出目录 |
| `formatter` | string / `npx oxfmt` | 生成后执行的格式化命令，后面自动追加 serviceDir；使用方须安装对应工具，失败仅警告 |
| `ignorePaths` | string[] / `[]` | 精确匹配完整 URL，保护已有函数和类型；尚未生成的接口仍新增 |
| `urlRequired` | boolean / `false` | true 时参数或交互必须提供 URL；false 时交互输入可留空以全量同步 |
| `requestOptions` | object / 关闭 | 为生成函数配置额外的可选参数及 HTTP 调用透传 |
| `requestOptions.enabled` | boolean / `false` | 开启额外参数；params 还需包含有效项目 |
| `requestOptions.typeImport` | string / 同 httpImport | 从哪个模块导入额外参数的类型 |
| `requestOptions.params` | object[] / `[]` | 额外参数列表，顺序决定 HTTP 调用参数的顺序 |
| `requestOptions.params[].name` | string / 无 | JS 参数标识符，如 config；不得重复或与业务参数 params 冲突 |
| `requestOptions.params[].type` | string / 无 | typeImport 导出的类型名称，如 AxiosRequestConfig；不支持复杂类型表达式 |
| `swagger` | object / `{}` | Swagger 命令配置，Apifox 命令不需要 |
| `swagger.url` | string / 无 | Swagger JSON 地址，执行 swagger 时必须提供（或设置 SWAGGER_URL） |
| `swagger.module` | string 或 string[] / 无 | contextFixed=true 时从路径中剥离的上下文 |
| `apifox` | object / `{}` | Apifox 命令配置，Swagger 命令不需要 |
| `apifox.url` | string / 无 | Apifox 导出地址，执行 apifox 时必须提供（或设置 APIFOX_URL） |
| `apifox.apiVersion` | string / `2024-03-28` | X-Apifox-Api-Version 请求头 |
| `apifox.token` | string / 无 | Apifox 认证令牌，执行 apifox 时必须提供（或设置 APIFOX_TOKEN） |
| `apifox.environmentIds` | ID 数组 / `[]` | 导出使用的环境 ID，不指定时发送空数组 |
| `apifox.selectedFolderIds` | ID 数组或分组对象 / `[]` | 导出的文件夹，数组单次导出；对象按键名分组并补上下文前缀，每个值必须为数组。建议明确填写实际 ID；空列表行为由 Apifox 决定 |
| `context` | object / `{}` | 兼容字段，新配置推荐使用 contextFixed 及来源模块字段 |
| `context.fixed` | boolean / `false` | contextFixed 未配置时的后备值 |
| `context.module` | string 或 string[] / `[]` | 来源未配置模块时的后备上下文，只影响目录，不为 Apifox 数组模式补 URL |

`SWAGGER_URL`、`APIFOX_URL`、`APIFOX_TOKEN` 的非空环境变量分别覆盖 `swagger.url`、`apifox.url`、`apifox.token`。环境变量不会代替配置文件本身，固定配置文件仍须存在。

对于使用 `||` 默认值的字符串配置，空字符串会使用默认值。额外参数中名称格式不合法或类型为空的条目会被过滤；请按样例配置有效的类型导出与互不冲突的参数名。

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

生成的 service 函数返回 `{ success, data, msg, error }`：

- HTTP 请求正常返回时，保留响应的 `success`、`data`、`msg`，并设置 `error: null`。响应为 `success: false` 时也遵循此规则。
- HTTP 请求抛出异常时，返回 `success: false`、`data: null`，`error` 保留原始异常。`msg` 优先使用异常对象的字符串 `msg`，其次使用字符串 `message`；字符串异常直接作为 `msg`，其他情况为 `""`。

已有函数仍按原有同步规则更新，不会仅因返回结构变化而自动升级。需要统一采用新结构时，可删除对应的生成文件后重新生成；删除前请保留自定义代码。

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

推送到 `main` 且修改 `src/**`、`bin/**`、`fetch-api-setting.example.json`、`package.json` 或 `package-lock.json` 时，`.github/workflows/release.yml` 自动执行测试，对照 npm 已发布版本与 gitHead 检测变化，递增 patch 版本，将版本提交推回 main，发布 npm 并创建版本标签。无需特定提交前缀；功能修改也默认递增 patch。需要 minor/major 时，提前修改 package.json 及 package-lock.json 的版本。

发布串行执行，不取消正在进行的发布。机器人版本提交使用 GITHUB_TOKEN，不会再次触发 workflow。发布前 push 遇到并发提交时失败，不强推；重新运行 workflow 会使用最新 main。npm 发布失败时可重跑，复用已准备的版本；发布成功但标签步骤失败时，手动运行 workflow 会补齐标签。仅文档/测试修改不发布；可从 Actions 手动运行 Release npm 进行恢复。

使用 npm Trusted Publishing（GitHub Actions OIDC），工作流拥有 `id-token: write`，不存储长期 NPM_TOKEN，发布附带 provenance。首次创建新包需由维护者本地登录后发布，再绑定：

```sh
npm publish
npm trust github cnhis-fetch-api-script --repo YWJ-hy/cnhis-fetch-api-script --file release.yml --allow-publish --yes
```

绑定需要 npm 11.15+ 和账户 2FA 验证。仓库必须允许 GitHub Actions 推送 main 和标签；若未来启用分支保护，请保留发布机器人的相应权限。CI 在 Windows/Linux、Node.js 22/24 上验证测试与打包。
