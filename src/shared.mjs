import fs from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  toPascalCase,
  sanitizeComment,
  createTypeContext,
  createNamedType,
  pickResponseSchema,
  buildParamsSchema,
  extractDataSchema,
} from "./types-gen.mjs";

const optionValue = name => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const projectRoot = path.resolve(optionValue("--cwd") || process.cwd());

/**
 * 读取并解析 fetch-api-setting.json 配置，自动合并环境变量。
 *
 * 动机与设计选择：
 * 1. 兼容性与容错性：原始 fetch-api-setting.json 允许包含 JavaScript 风格的注释（如单行 // 和多行 /*），
 *    但原生 JSON.parse 无法直接解析带注释的文本。为了避免开发者配置注释时发生解析失败，
 *    在解析前使用正则表达式将多行与单行注释剥离。
 * 2. 错误透明度：避免单纯吞掉所有异常，若读取或解析失败，显式打印出异常原因（如 JSON 语法错误），
 *    以便开发者能快速定位到具体的配置错误位置。
 */
const loadSettings = async () => {
  const settingsPath = path.join(projectRoot, "fetch-api-setting.json");
  let settings = {};
  try {
    const raw = await fs.readFile(settingsPath, "utf-8");
    // 关键点：使用经典 JSON 剥离注释正则，通过匹配双引号字符串并原样返回的方式，
    // 安全地避开字符串内的协议头（如 http://），只滤除真正的单行与多行注释。
    const cleanJson = raw.replace(
      /("([^"\\]|\\.)*")|(\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\/)|(\/\/.*)/g,
      (match, g1) => (g1 ? g1 : ""),
    );
    settings = JSON.parse(cleanJson);
  } catch (err) {
    throw new Error(`读取配置失败 (${settingsPath}): ${err.message}`);
  }
  if (process.env.SWAGGER_URL) {
    settings.swagger = { ...settings.swagger, url: process.env.SWAGGER_URL };
  }
  if (process.env.APIFOX_URL) {
    settings.apifox = { ...settings.apifox, url: process.env.APIFOX_URL };
  }
  if (process.env.APIFOX_TOKEN) {
    settings.apifox = { ...settings.apifox, token: process.env.APIFOX_TOKEN };
  }
  return settings;
};

const normalizeGitBashUrl = value =>
  String(value).replace(/^[A-Za-z]:\/Program Files\/Git\//i, "/");

export const parseTargetUrls = (argv = process.argv.slice(2)) => {
  const urls = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--url" && i + 1 < argv.length) {
      urls.push(normalizeGitBashUrl(argv[++i]));
    }
  }
  return urls;
};

const parseCliArgs = settings => {
  const argv = process.argv.slice(2);
  const keepApiJson = argv.includes("--keep-api-json");
  const forceUpdateUrls = parseTargetUrls(argv);

  // urlRequired 为 true 时保持旧行为：不传 --url 则报错退出
  // 默认 false，不传 --url 则同步全部接口
  if (settings?.urlRequired && !forceUpdateUrls.length) {
    console.error("错误：必须通过 --url 参数指定至少一个接口路径");
    console.error("用法：cnhis-fetch-api <swagger|apifox> --url /xxx/yyy");
    process.exit(1);
  }

  return { keepApiJson, forceUpdateUrls };
};

const buildEndpoints = swagger => {
  const result = [];
  const skipped = [];
  const paths = swagger.paths || {};
  Object.keys(paths).forEach(url => {
    const methods = paths[url] || {};
    Object.keys(methods).forEach(method => {
      const lower = method.toLowerCase();
      // 仅支持 get / post；其余请求方式（put/delete/patch 等）跳过并记录日志。
      // 因为同一 URL 常同时声明多种方法，且生成代码里 put/delete/patch 都写成 http.post，
      // 保留它们会导致重命名检测无法稳定（详见 collectFunctionUrls 注释）。
      if (!["get", "post"].includes(lower)) {
        skipped.push(`${lower.toUpperCase()} ${url}`);
        return;
      }
      const operation = methods[method] || {};
      const summary = operation.summary || operation.description || "";
      const paramsSchema = buildParamsSchema(swagger, operation.parameters || []);
      const responseSchema = pickResponseSchema(operation.responses || {});
      const dataSchema = extractDataSchema(responseSchema, swagger);
      result.push({ url, method: lower, summary, paramsSchema, responseSchema: dataSchema });
    });
  });
  if (skipped.length) {
    console.log(
      `  [已过滤] 仅支持 GET/POST，已跳过 ${skipped.length} 个端点：${skipped.join(", ")}`,
    );
  }
  return result;
};

/**
 * 按模块分组 endpoint。
 * contextFixed 为 true 时，将上下文前缀剥离，模块名取下一段路径。
 * contextModules 由调用方根据数据来源（swagger / apifox）传入。
 * contextFixed 为 false 时，取前两段路径拼接为模块名。
 */
const groupByModule = (endpoints, settings, contextModules = []) => {
  const map = new Map();
  const fixedContext = settings?.contextFixed ?? settings?.context?.fixed ?? false;

  endpoints.forEach(item => {
    const parts = item.url.split("/").filter(Boolean);
    let moduleName;
    let actionParts;

    if (fixedContext && contextModules.length) {
      if (contextModules.includes(parts[0]) && parts.length > 1) {
        moduleName = parts[1];
        actionParts = parts.slice(2);
      } else {
        moduleName = parts[0] || "api";
        actionParts = parts.slice(1);
      }
    } else {
      moduleName = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0] || "api";
      actionParts = parts.slice(parts.length >= 2 ? 2 : 1);
    }

    // 用模块之后的所有路径段拼接为 functionName，避免仅取最后一段导致不同路径生成同名函数
    const baseName = actionParts.length
      ? actionParts.map(seg => toPascalCase(seg)).join("")
      : `${toPascalCase(moduleName)}Index`;
    const functionName = baseName + toPascalCase(item.method);
    const moduleItem = { ...item, moduleName, functionName };
    if (!map.has(moduleName)) map.set(moduleName, []);
    map.get(moduleName).push(moduleItem);
  });
  return map;
};

const renderTypes = (swagger, moduleEndpoints) => {
  const ctx = createTypeContext();
  const endpointTypes = new Map();

  moduleEndpoints.forEach(endpoint => {
    const { functionName, paramsSchema, responseSchema } = endpoint;
    let paramsTypeName = null;
    let resultTypeName = null;
    if (paramsSchema) {
      paramsTypeName = `${functionName}Params`;
      createNamedType(swagger, ctx, paramsSchema, paramsTypeName, true, paramsTypeName);
    }
    if (responseSchema) {
      resultTypeName = `${functionName}Result`;
      createNamedType(swagger, ctx, responseSchema, resultTypeName, true, resultTypeName);
    }
    endpointTypes.set(functionName, { paramsTypeName, resultTypeName });
  });

  const typesBlocks = ctx.order
    .map(name => {
      const def = ctx.defs.get(name);
      if (!def) return null;
      let output = def.code;
      if (def.exported && output.startsWith("interface ")) output = `export ${output}`;
      if (def.exported && output.startsWith("type ")) output = `export ${output}`;
      return { name, code: output };
    })
    .filter(Boolean);

  const namespaceBlocks = Array.from(ctx.namespaces.entries()).map(([namespace, nsCtx]) => {
    const blocks = nsCtx.order
      .map(name => {
        const def = nsCtx.defs.get(name);
        if (!def) return null;
        return { name, code: def.code };
      })
      .filter(Boolean);
    return { namespace, blocks };
  });

  return { typesBlocks, namespaceBlocks, endpointTypes };
};

const normalizeRequestOptions = (requestOptions, defaultTypeImport) => {
  if (!requestOptions?.enabled) return null;

  const params = Array.isArray(requestOptions.params)
    ? requestOptions.params.filter(
        item =>
          item &&
          /^[A-Za-z_$][\w$]*$/.test(item.name) &&
          typeof item.type === "string" &&
          item.type.trim(),
      )
    : [];
  if (!params.length) return null;
  const normalizedParams = params.map(item => ({ ...item, type: item.type.trim() }));

  return {
    params: normalizedParams,
    types: [...new Set(normalizedParams.map(item => item.type))],
    typeImport: requestOptions.typeImport || defaultTypeImport,
  };
};

const renderIndexFunctions = (moduleEndpoints, endpointTypes, requestOptions) => {
  const importTypes = new Set();
  const lines = [];

  moduleEndpoints.forEach(endpoint => {
    const types = endpointTypes.get(endpoint.functionName) || {};
    if (types.paramsTypeName) importTypes.add(types.paramsTypeName);
    if (types.resultTypeName) importTypes.add(types.resultTypeName);
  });

  moduleEndpoints.forEach(endpoint => {
    const { functionName, paramsSchema, url, method, summary } = endpoint;
    const types = endpointTypes.get(functionName) || {};
    const paramsTypeName = types.paramsTypeName;
    const resultTypeName = types.resultTypeName || "any";

    if (summary) lines.push(`/** ${sanitizeComment(summary)} */`);
    const requestParamsText = requestOptions
      ? `, ${requestOptions.params.map(item => `${item.name}?: ${item.type}`).join(", ")}`
      : "";
    const requestArgsText = requestOptions
      ? `, ${requestOptions.params.map(item => item.name).join(", ")}`
      : "";
    const paramsText = paramsSchema
      ? `(params: ${paramsTypeName}${requestParamsText})`
      : `(${requestOptions ? requestParamsText.slice(2) : ""})`;
    lines.push(`export const ${functionName} = async ${paramsText} => {`);
    lines.push("  try {");
    const httpCall =
      method === "get"
        ? `http.get<${resultTypeName}>("${url}", ${paramsSchema ? "params" : "undefined"}${requestArgsText})`
        : `http.post<${resultTypeName}>("${url}", ${paramsSchema ? "params" : "undefined"}${requestArgsText})`;
    lines.push(`    const { success, data, msg } = await ${httpCall};`);
    lines.push("    return {");
    lines.push("      success,");
    lines.push("      data,");
    lines.push("      msg,");
    lines.push("      error: null,");
    lines.push("    };");
    lines.push("  } catch (error) {");
    lines.push('    const msg = typeof error === "string"');
    lines.push("      ? error");
    lines.push('      : error && typeof error === "object"');
    lines.push('        ? "msg" in error && typeof error.msg === "string"');
    lines.push("          ? error.msg");
    lines.push('          : "message" in error && typeof error.message === "string"');
    lines.push("            ? error.message");
    lines.push('            : ""');
    lines.push('        : "";');
    lines.push("    return {");
    lines.push("      success: false,");
    lines.push("      data: null,");
    lines.push("      msg,");
    lines.push("      error,");
    lines.push("    };");
    lines.push("  }");
    lines.push("};");
    lines.push("");
  });

  return { functionsContent: lines.join("\n").trimEnd(), importTypes };
};

const upsertHttpTypeImport = (
  content,
  typeImport,
  requiredTypes,
  defaultHttpImport = typeImport,
) => {
  const escapedTypeImport = typeImport.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const typeImportRegex = new RegExp(
    `import\\s+type\\s*\\{([^}]*)\\}\\s*from\\s*["']${escapedTypeImport}["'];?`,
  );
  const match = content.match(typeImportRegex);

  if (match) {
    const existingTypes = match[1]
      .split(",")
      .map(item => item.trim())
      .filter(Boolean);
    const mergedTypes = Array.from(new Set([...existingTypes, ...requiredTypes])).sort();
    return content.replace(
      typeImportRegex,
      `import type { ${mergedTypes.join(", ")} } from "${typeImport}";`,
    );
  }

  const escapedDefaultHttpImport = defaultHttpImport.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const httpImportRegex = new RegExp(
    `import\\s+http\\s+from\\s+["']${escapedDefaultHttpImport}["'];?`,
  );
  if (httpImportRegex.test(content)) {
    return content.replace(
      httpImportRegex,
      importLine =>
        `${importLine}\nimport type { ${requiredTypes.join(", ")} } from "${typeImport}";`,
    );
  }

  return `import type { ${requiredTypes.join(", ")} } from "${typeImport}";\n${content}`;
};

const readFileSafe = async filePath => {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
};

const collectExportedConsts = content => {
  const result = new Set();
  if (!content) return result;
  const regex = /export\s+const\s+([A-Za-z_$][\w$]*)/g;
  let match = null;
  while ((match = regex.exec(content))) result.add(match[1]);
  return result;
};

/**
 * 去除空白差异后比较类型代码，避免格式化工具造成的缩进/换行差异导致误判。
 * 除了把连续空白折叠为单个空格外，还需移除标点符号（<>{}[](),;:|&? 等）周围的空白，
 * 否则格式化工具把长泛型换行成 `Nullable<\n  X\n>` 时，归一化后会残留 `Nullable< X >`，
 * 与生成代码的 `Nullable<X>` 永不相等，导致每次执行都误判为「类型变化」。
 */
const normalizeForCompare = code =>
  code
    .replace(/\s+/g, " ")
    .replace(/\s*([<>{}[\](),;:|&?])\s*/g, "$1")
    .trim();

/**
 * 从 types.d.ts 内容中按名称提取单个类型定义。
 * kind 区分全局类型（interface/type）与 namespace，因为同名可能同时存在两种形式。
 * 正则策略与 replaceTypeDefinitions 保持一致。
 */
const extractTypeDef = (content, name, kind) => {
  if (!content) return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (kind === "namespace") {
    const m = content.match(
      new RegExp(`export\\s+namespace\\s+${escaped}\\s*\\{[\\s\\S]*?^\\}`, "m"),
    );
    return m ? m[0] : null;
  }
  const ifMatch = content.match(
    new RegExp(`export\\s+interface\\s+${escaped}\\s*(?:\\{\\s*\\}|\\{[\\s\\S]*?^\\})`, "m"),
  );
  if (ifMatch) return ifMatch[0];
  const typeMatch = content.match(new RegExp(`export\\s+type\\s+${escaped}\\s*=[^;]*;`, "m"));
  return typeMatch ? typeMatch[0] : null;
};

/**
 * 全量同步时，找出入参/出参类型签名有变化的已存在函数。
 * 重新生成类型代码并与现有 types.d.ts 做归一化比较，
 * 只有实际内容不同才纳入更新列表，减少无意义覆盖。
 */
const detectChangedEndpoints = (candidates, existingTypesContent, swagger) => {
  if (!candidates.length) return [];
  if (!existingTypesContent) return candidates;

  const { typesBlocks, namespaceBlocks, endpointTypes } = renderTypes(swagger, candidates);
  const changed = [];

  for (const ep of candidates) {
    const types = endpointTypes.get(ep.functionName);
    if (!types) continue;

    const namesToCheck = [types.paramsTypeName, types.resultTypeName].filter(Boolean);
    let hasChange = false;

    for (const name of namesToCheck) {
      const newBlock = typesBlocks.find(b => b.name === name);
      if (newBlock) {
        const newCode = newBlock.code.startsWith("export ")
          ? newBlock.code
          : `export ${newBlock.code}`;
        const existing = extractTypeDef(existingTypesContent, name, "global");
        if (!existing || normalizeForCompare(existing) !== normalizeForCompare(newCode)) {
          hasChange = true;
          break;
        }
      }

      const nsBlock = namespaceBlocks.find(b => b.namespace === name);
      if (nsBlock) {
        const body = nsBlock.blocks
          .map(b => b.code)
          .join("\n\n")
          .split("\n")
          .map(l => `  ${l}`)
          .join("\n");
        const newNsCode = `export namespace ${name} {\n${body}\n}`;
        const existingNs = extractTypeDef(existingTypesContent, name, "namespace");
        if (!existingNs || normalizeForCompare(existingNs) !== normalizeForCompare(newNsCode)) {
          hasChange = true;
          break;
        }
      }
    }

    if (hasChange) changed.push(ep);
  }

  return changed;
};

/**
 * 从 index.ts 中提取每个导出函数的「请求方式 + URL」唯一键（如 `post /catalog/items/query`）。
 * 用于检测同一 (方法, URL) 的 functionName 是否因命名规则变更而需要重命名。
 *
 * 注意：请求方式取自函数名后缀（Get/Post/Put/Delete/Patch），而非 http.xxx。
 * 因为生成代码里 put/delete/patch 都写成 http.post，从请求调用无法区分真实方法，
 * 若仅用 URL 或用 http.xxx 的方法作键，同一 URL 的多个方法会互相覆盖，
 * 导致重命名检测把幸存者误判为其余方法的「旧名」，每次执行都删除并重新追加，无法收敛。
 */
const collectFunctionUrls = content => {
  const result = new Map();
  if (!content) return result;
  const funcRegex =
    /(?:\/\*\*(?:[^*]|\*(?!\/))*\*\/\s*)?export\s+const\s+([A-Za-z_$][\w$]*)\s*=[\s\S]*?^};/gm;
  let match;
  while ((match = funcRegex.exec(content))) {
    const name = match[1];
    const body = match[0];
    const urlMatch = body.match(
      /http\.(?:get|post|put|delete|patch)\s*(?:<[^>]*>)?\(\s*\n?\s*"([^"]+)"/,
    );
    if (!urlMatch) continue;
    const methodMatch = name.match(/(Get|Post|Put|Delete|Patch)$/);
    const method = methodMatch ? methodMatch[1].toLowerCase() : "";
    result.set(name, `${method} ${urlMatch[1]}`);
  }
  return result;
};

/**
 * 从 index.ts 中整体移除一个导出函数（含其前置 JSDoc 注释）。
 * 与 replaceExportedFunction 的正则策略一致，但替换为空字符串而非新代码。
 */
const removeExportedFunction = (content, functionName) => {
  const escaped = functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(
    `(?:\\/\\*\\*(?:[^*]|\\*(?!\\/))*\\*\\/\\s*)?export\\s+const\\s+${escaped}\\s*=[\\s\\S]*?^\\};\\n*`,
    "m",
  );
  return content.replace(regex, "");
};

/**
 * 从 import type { ... } from "./types" 语句中移除指定的类型名。
 * 如果移除后不再引用任何类型，则整行删除。
 */
const removeTypeImports = (content, typeNames) => {
  if (!typeNames.length) return content;
  const regex = /import\s+type\s+\{([^}]+)\}\s*from\s*["']\.\x2ftypes["'];/m;
  const match = content.match(regex);
  if (!match) return content;
  const removeSet = new Set(typeNames);
  const remaining = match[1]
    .split(",")
    .map(s => s.trim())
    .filter(s => s && !removeSet.has(s));
  if (!remaining.length) return content.replace(regex, "").replace(/^\s*\n/m, "");
  return content.replace(regex, `import type { ${remaining.join(", ")} } from "./types";`);
};

const replaceExportedFunction = (content, functionName, newFunctionCode) => {
  const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(
    `(?:\\/\\*\\*(?:[^*]|\\*(?!\\/))*\\*\\/\\s*)?export\\s+const\\s+${escapedName}\\s*=[\\s\\S]*?^\\};`,
    "m",
  );
  if (!content.match(regex)) return null;
  return content.replace(regex, newFunctionCode.trim());
};

/**
 * 原地替换已存在的类型定义，新类型追加到文件末尾。
 * 保留已有类型在文件中的位置不变，方便通过 git diff 查看具体字段变化。
 *
 * @param {string} content - 当前 types.d.ts 文件内容
 * @param {Array<{name: string, code: string, kind: 'namespace' | 'type'}>} entries - 类型条目数组
 *   同一个 name 可能同时存在 namespace 和 interface/type 两种形式，因此使用数组而非 Map
 */
const replaceTypeDefinitions = (content, entries) => {
  let result = content;
  const appendItems = [];

  for (const { name, code, kind } of entries) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const replacement = code.trim();

    let matched = false;

    if (kind === "namespace") {
      const nsRegex = new RegExp(`export\\s+namespace\\s+${escapedName}\\s*\\{[\\s\\S]*?^\\}`, "m");
      if (nsRegex.test(result)) {
        result = result.replace(nsRegex, replacement);
        matched = true;
      }
    } else {
      // interface 或 type alias
      const ifRegex = new RegExp(
        `export\\s+interface\\s+${escapedName}\\s*(?:\\{\\s*\\}|\\{[\\s\\S]*?^\\})`,
        "m",
      );
      const typeRegex = new RegExp(`export\\s+type\\s+${escapedName}\\s*=[^;]*;`, "m");
      if (ifRegex.test(result)) {
        result = result.replace(ifRegex, replacement);
        matched = true;
      } else if (typeRegex.test(result)) {
        result = result.replace(typeRegex, replacement);
        matched = true;
      }
    }

    // 未匹配到且有新代码时，追加到文件末尾
    if (!matched && replacement) {
      appendItems.push(replacement);
    }
  }

  result = result.replace(/\n{3,}/g, "\n\n").trimEnd();
  if (appendItems.length) {
    result = `${result}\n\n${appendItems.join("\n\n")}\n`;
  } else {
    result += "\n";
  }
  return result;
};

const collectTypeNamesByScope = content => {
  const result = { global: new Set(), namespaces: new Map() };
  if (!content) return result;

  const namespaceRanges = [];
  const nsRegex = /\b(?:export\s+)?namespace\s+([A-Za-z_$][\w$]*)\s*\{/g;
  let match = null;
  while ((match = nsRegex.exec(content))) {
    const namespace = match[1];
    let index = match.index + match[0].length;
    let depth = 1;
    while (index < content.length && depth > 0) {
      const char = content[index++];
      if (char === "{") depth += 1;
      if (char === "}") depth -= 1;
    }
    const end = index;
    const body = content.slice(match.index + match[0].length, end - 1);
    const set = result.namespaces.get(namespace) || new Set();
    const typeRegex = /\b(?:export\s+)?(?:interface|type)\s+([A-Za-z_$][\w$]*)/g;
    let typeMatch = null;
    while ((typeMatch = typeRegex.exec(body))) set.add(typeMatch[1]);
    result.namespaces.set(namespace, set);
    namespaceRanges.push([match.index, end]);
    nsRegex.lastIndex = end;
  }

  if (namespaceRanges.length) {
    let last = 0;
    let globalContent = "";
    for (const [start, end] of namespaceRanges) {
      globalContent += content.slice(last, start);
      last = end;
    }
    globalContent += content.slice(last);
    content = globalContent;
  }

  const regex = /\b(?:export\s+)?(?:interface|type)\s+([A-Za-z_$][\w$]*)/g;
  let typeMatch = null;
  while ((typeMatch = regex.exec(content))) result.global.add(typeMatch[1]);
  return result;
};

const upsertTypesImport = (content, names, httpImport) => {
  if (!names.size) return content;
  const regex = /import\s+(type\s+)?\{([^}]+)\}\s*from\s*["']\.\/types["'];/m;
  const match = content.match(regex);
  const newNames = Array.from(names);
  if (match) {
    const existing = match[2]
      .split(",")
      .map(item => item.trim())
      .filter(Boolean);
    const merged = Array.from(new Set([...existing, ...newNames])).sort();
    return content.replace(regex, `import type { ${merged.join(", ")} } from "./types";`);
  }
  const httpRegex = new RegExp(
    `import\\s+http\\s+from\\s+["']${httpImport.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'];`,
  );
  if (httpRegex.test(content)) {
    return content.replace(
      httpRegex,
      matchLine => `${matchLine}\nimport type { ${newNames.sort().join(", ")} } from "./types";`,
    );
  }
  return `import type { ${newNames.sort().join(", ")} } from "./types";\n${content}`;
};

const writeModuleFiles = async (
  moduleName,
  moduleEndpoints,
  swagger,
  forceUpdate,
  serviceRoot,
  httpImport,
  requestOptions,
  ignorePaths = [],
) => {
  const ignoreSet = new Set(ignorePaths);
  const moduleDir = path.join(serviceRoot, moduleName);
  await fs.mkdir(moduleDir, { recursive: true });
  let hasAnyUpdate = false;

  const indexPath = path.join(moduleDir, "index.ts");
  const typesPath = path.join(moduleDir, "types.d.ts");
  let existingIndex = await readFileSafe(indexPath);
  let existingTypes = await readFileSafe(typesPath);

  // 按名称及 (请求方式, URL) 识别已有接口，保护旧命名函数，避免追加同一接口的新名称。
  const originalFunctions = collectExportedConsts(existingIndex);
  const originalKeys = new Set(collectFunctionUrls(existingIndex).values());
  moduleEndpoints = moduleEndpoints.filter(ep => {
    const ignored =
      ignoreSet.has(ep.url) &&
      (originalFunctions.has(ep.functionName) || originalKeys.has(`${ep.method} ${ep.url}`));
    if (ignored) console.log(`  [跳过] ${moduleName}: ${ep.functionName}（已配置 ignorePaths）`);
    return !ignored;
  });
  if (!moduleEndpoints.length) return false;

  // 检测已有函数的 (请求方式, URL) 是否对应了不同的 functionName（命名规则变更导致），
  // 若存在差异则先移除旧函数及其类型，让后续追加逻辑以新名称重新生成
  if (existingIndex) {
    const functionKeys = collectFunctionUrls(existingIndex);
    const keyToOldName = new Map();
    for (const [name, key] of functionKeys) keyToOldName.set(key, name);

    const renames = [];
    for (const ep of moduleEndpoints) {
      const oldName = keyToOldName.get(`${ep.method} ${ep.url}`);
      if (oldName && oldName !== ep.functionName) {
        renames.push({ oldName, newName: ep.functionName });
      }
    }

    if (renames.length) {
      const removedTypeNames = [];
      for (const { oldName } of renames) {
        existingIndex = removeExportedFunction(existingIndex, oldName);
        removedTypeNames.push(`${oldName}Params`, `${oldName}Result`);
      }
      existingIndex = removeTypeImports(existingIndex, removedTypeNames);
      existingIndex = existingIndex.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";

      if (existingTypes) {
        // 删除旧类型：每个名称同时生成 namespace 和 type 两种条目，确保全部清除
        const removeEntries = removedTypeNames.flatMap(n => [
          { name: n, code: "", kind: "namespace" },
          { name: n, code: "", kind: "type" },
        ]);
        existingTypes = replaceTypeDefinitions(existingTypes, removeEntries);
      }

      await fs.writeFile(indexPath, existingIndex);
      if (existingTypes) await fs.writeFile(typesPath, existingTypes);

      console.log(
        `  [重命名] ${moduleName}: ${renames.map(r => `${r.oldName} → ${r.newName}`).join(", ")}`,
      );
      hasAnyUpdate = true;
    }
  }

  const existingFunctions = collectExportedConsts(existingIndex);

  const existingEndpoints = moduleEndpoints.filter(ep => existingFunctions.has(ep.functionName));
  const appendEndpoints = moduleEndpoints.filter(ep => !existingFunctions.has(ep.functionName));

  // --url 模式或启用请求配置时，更新全部已存在函数；
  // 其他全量同步场景只更新类型签名有变化的函数，避免无意义的覆盖
  const updateEndpoints =
    forceUpdate || requestOptions
      ? existingEndpoints
      : detectChangedEndpoints(existingEndpoints, existingTypes, swagger);

  if (!updateEndpoints.length && !appendEndpoints.length && existingIndex) return false;

  if (updateEndpoints.length && existingIndex) {
    const { typesBlocks, namespaceBlocks, endpointTypes } = renderTypes(swagger, updateEndpoints);
    const { functionsContent, importTypes } = renderIndexFunctions(
      updateEndpoints,
      endpointTypes,
      requestOptions,
    );

    let updatedIndex = existingIndex;
    const segments = functionsContent.split(/(?=\/\*\*|export\s+const\s+)/).filter(Boolean);
    const functionBlocks = [];
    let currentBlock = "";
    for (const segment of segments) {
      if (segment.trimStart().startsWith("export const") && currentBlock) {
        currentBlock += segment;
        functionBlocks.push(currentBlock.trim());
        currentBlock = "";
      } else if (segment.trimStart().startsWith("/**")) {
        if (currentBlock) functionBlocks.push(currentBlock.trim());
        currentBlock = segment;
      } else if (segment.trimStart().startsWith("export const")) {
        if (currentBlock) functionBlocks.push(currentBlock.trim());
        functionBlocks.push(segment.trim());
        currentBlock = "";
      } else {
        currentBlock += segment;
      }
    }
    if (currentBlock.trim()) functionBlocks.push(currentBlock.trim());

    for (const block of functionBlocks) {
      const nameMatch = block.match(/export\s+const\s+([A-Za-z_$][\w$]*)/);
      if (!nameMatch) continue;
      const replaced = replaceExportedFunction(updatedIndex, nameMatch[1], block);
      if (replaced) updatedIndex = replaced;
    }

    if (requestOptions) {
      updatedIndex = upsertHttpTypeImport(
        updatedIndex,
        requestOptions.typeImport,
        requestOptions.types,
        httpImport,
      );
    }
    if (importTypes.size) updatedIndex = upsertTypesImport(updatedIndex, importTypes, httpImport);

    // index.ts 只在实际变化时写入
    if (updatedIndex !== existingIndex) {
      await fs.writeFile(indexPath, updatedIndex);
    }

    let typesChanged = false;
    if (existingTypes && (typesBlocks.length || namespaceBlocks.length)) {
      // 构建 entries 数组，namespace 和 interface/type 各自独立条目，同名不冲突
      const typeEntries = [];
      for (const entry of namespaceBlocks) {
        const body = entry.blocks
          .map(b => b.code)
          .join("\n\n")
          .split("\n")
          .map(l => `  ${l}`)
          .join("\n");
        typeEntries.push({
          name: entry.namespace,
          code: `export namespace ${entry.namespace} {\n${body}\n}`,
          kind: "namespace",
        });
      }
      for (const b of typesBlocks) {
        typeEntries.push({ name: b.name, code: b.code, kind: "type" });
      }
      const updatedTypes = replaceTypeDefinitions(existingTypes, typeEntries);
      if (updatedTypes !== existingTypes) {
        await fs.writeFile(typesPath, updatedTypes);
        typesChanged = true;
      }
    }

    if (typesChanged || updatedIndex !== existingIndex) {
      const updateLabel = forceUpdate ? "更新" : "类型变化";
      console.log(
        `  [${updateLabel}] ${moduleName}: ${updateEndpoints.map(ep => ep.functionName).join(", ")}`,
      );
      hasAnyUpdate = true;
    }
  }

  if (!appendEndpoints.length && existingIndex) return hasAnyUpdate;

  if (appendEndpoints.length || !existingIndex) {
    const targetEndpoints = appendEndpoints.length ? appendEndpoints : moduleEndpoints;
    const { typesBlocks, namespaceBlocks, endpointTypes } = renderTypes(swagger, targetEndpoints);
    const { functionsContent, importTypes } = renderIndexFunctions(
      targetEndpoints,
      endpointTypes,
      requestOptions,
    );

    const currentTypes = await readFileSafe(typesPath);
    const currentIndex = await readFileSafe(indexPath);
    const typeNames = collectTypeNamesByScope(currentTypes);
    const newGlobalBlocks = typesBlocks.filter(block => !typeNames.global.has(block.name));
    const newNamespaceBlocks = namespaceBlocks
      .map(entry => {
        const existing = typeNames.namespaces.get(entry.namespace) || new Set();
        const blocks = entry.blocks.filter(block => !existing.has(block.name));
        return { namespace: entry.namespace, blocks };
      })
      .filter(entry => entry.blocks.length);

    const namespaceOrder = new Map();
    newGlobalBlocks.forEach((block, index) => {
      const match = block.name.match(/^(.*?)(Params|Result)$/);
      if (!match) return;
      if (newNamespaceBlocks.some(entry => entry.namespace === block.name)) {
        namespaceOrder.set(block.name, index);
      }
    });

    const appendTypes = [];
    if (newNamespaceBlocks.length) {
      const sorted = [...newNamespaceBlocks].sort((a, b) => {
        const aI = namespaceOrder.has(a.namespace) ? namespaceOrder.get(a.namespace) : Infinity;
        const bI = namespaceOrder.has(b.namespace) ? namespaceOrder.get(b.namespace) : Infinity;
        if (aI !== bI) return aI - bI;
        return a.namespace.localeCompare(b.namespace);
      });
      sorted.forEach(entry => {
        const body = entry.blocks
          .map(b => b.code)
          .join("\n\n")
          .split("\n")
          .map(l => `  ${l}`)
          .join("\n");
        appendTypes.push(`export namespace ${entry.namespace} {\n${body}\n}`);
      });
    }
    if (newGlobalBlocks.length) {
      appendTypes.push(newGlobalBlocks.map(b => b.code).join("\n\n"));
    }

    if (appendTypes.length) {
      const appendText = `${appendTypes.join("\n\n")}\n`;
      if (currentTypes) {
        await fs.writeFile(typesPath, `${currentTypes.trimEnd()}\n\n${appendText}`);
      } else {
        await fs.writeFile(typesPath, appendText);
      }
    }

    if (appendEndpoints.length) {
      console.log(
        `  [新增] ${moduleName}: ${appendEndpoints.map(ep => ep.functionName).join(", ")}`,
      );
      hasAnyUpdate = true;
    }

    if (currentIndex) {
      let nextIndex = currentIndex;
      if (requestOptions) {
        nextIndex = upsertHttpTypeImport(
          nextIndex,
          requestOptions.typeImport,
          requestOptions.types,
          httpImport,
        );
      }
      if (importTypes.size) nextIndex = upsertTypesImport(nextIndex, importTypes, httpImport);
      if (functionsContent.trim()) {
        nextIndex = `${nextIndex.trimEnd()}\n\n${functionsContent}\n`;
      } else if (!nextIndex.endsWith("\n")) {
        nextIndex += "\n";
      }
      await fs.writeFile(indexPath, nextIndex);
      return hasAnyUpdate;
    }

    const fullLines = [`import http from "${httpImport}";`];
    if (requestOptions) {
      fullLines.push(
        `import type { ${requestOptions.types.join(", ")} } from "${requestOptions.typeImport}";`,
      );
    }
    if (importTypes.size) {
      fullLines.push(`import { ${Array.from(importTypes).sort().join(", ")} } from "./types";`);
    }
    fullLines.push("");
    if (functionsContent.trim()) fullLines.push(functionsContent.trimEnd());
    await fs.writeFile(indexPath, `${fullLines.join("\n").trimEnd()}\n`);
  }
  return hasAnyUpdate;
};

/**
 * 统一入口：接收数据获取函数，执行完整的 API 同步流程。
 * @param {Function} fetchSwagger - async 函数，返回 OpenAPI/Swagger JSON 对象
 * @param {"swagger" | "apifox"} source - 数据来源标识，用于推导上下文模块列表
 */
export const runFetchApiSync = async (fetchSwagger, source) => {
  const settings = await loadSettings();
  const { keepApiJson, forceUpdateUrls } = parseCliArgs(settings);

  const apiJsonPath = path.join(projectRoot, "api.json");
  const serviceRoot = path.join(projectRoot, settings.serviceDir || "src/service2");
  const httpImport = settings.httpImport || "@/common/utils/http";
  const requestOptions = normalizeRequestOptions(settings.requestOptions, httpImport);
  const formatter = settings.formatter || "npx oxfmt";

  // 根据数据来源推导上下文模块列表
  const folderIds = settings?.apifox?.selectedFolderIds;
  const configuredModules =
    source === "apifox"
      ? Array.isArray(folderIds)
        ? []
        : Object.keys(folderIds || {})
      : settings?.swagger?.module
        ? [settings.swagger.module].flat()
        : [];
  const contextModules = (
    configuredModules.length ? configuredModules : [settings?.context?.module || []].flat()
  )
    .map(value => String(value).replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);

  const swagger = await fetchSwagger();
  await fs.writeFile(apiJsonPath, JSON.stringify(swagger, null, 2));

  let endpoints = buildEndpoints(swagger);
  const hasUrlFilter = forceUpdateUrls.length > 0;

  if (hasUrlFilter) {
    endpoints = endpoints.filter(ep => forceUpdateUrls.includes(ep.url));
    if (!endpoints.length) {
      console.warn(`未找到匹配的 URL: ${forceUpdateUrls.join(", ")}`);
      console.warn("请确认 URL 路径是否正确（需包含完整路径如 /xxx/yyy/zzz）");
      if (!keepApiJson) await fs.rm(apiJsonPath, { force: true });
      return;
    }
  }

  const moduleMap = groupByModule(endpoints, settings, contextModules);

  await fs.mkdir(serviceRoot, { recursive: true });
  let hasAnyUpdate = false;
  for (const [moduleName, moduleEndpoints] of moduleMap.entries()) {
    const updated = await writeModuleFiles(
      moduleName,
      moduleEndpoints,
      swagger,
      hasUrlFilter,
      serviceRoot,
      httpImport,
      requestOptions,
      settings.ignorePaths || [],
    );
    if (updated) hasAnyUpdate = true;
  }

  if (!keepApiJson) await fs.rm(apiJsonPath, { force: true });

  try {
    execSync(`${formatter} ${settings.serviceDir || "src/service2"}`, {
      stdio: "inherit",
      cwd: projectRoot,
    });
  } catch {
    console.warn(`格式化失败，请手动执行：${formatter} ${settings.serviceDir || "src/service2"}`);
  }

  if (!hasAnyUpdate) console.log("无任何更新");
  console.log("同步完成");
};

export { loadSettings };
