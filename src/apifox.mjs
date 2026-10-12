import { runFetchApiSync, loadSettings, parseTargetUrls } from "./shared.mjs";

// 调用例子：
//   cnhis-fetch-api apifox
//   cnhis-fetch-api apifox --url /catalog/xxx/yyy
//   APIFOX_TOKEN=xxx cnhis-fetch-api apifox --url /catalog/xxx/yyy --keep-api-json

const buildApifoxHeaders = apifox => {
  const token = apifox.token;
  if (!token) throw new Error("缺少 apifox.token 配置（fetch-api-setting.json 或 APIFOX_TOKEN 环境变量）");
  return {
    "X-Apifox-Api-Version": apifox.apiVersion || "2024-03-28",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
};

const buildApifoxPayload = (folderIds, apifox) => ({
  scope: {
    type: "SELECTED_FOLDERS",
    selectedFolderIds: folderIds,
  },
  options: {
    includeApifoxExtensionProperties: false,
    addFoldersToTags: false,
  },
  oasVersion: "2.0",
  exportFormat: "JSON",
  environmentIds: apifox.environmentIds || [],
});

/**
 * 给 swagger paths 补全上下文前缀。
 * apifox 导出的接口 path 不含前置 URL，需要手动拼接为实际路径。
 */
const prependContextToPaths = (swagger, context) => {
  const prefix = context ? `/${context}` : "";
  const newPaths = {};
  for (const [url, methods] of Object.entries(swagger.paths || {})) {
    const normalizedUrl = url.startsWith("/") ? url : `/${url}`;
    const hasPrefix = normalizedUrl === prefix || normalizedUrl.startsWith(`${prefix}/`);
    newPaths[hasPrefix ? normalizedUrl : `${prefix}${normalizedUrl}`] = methods;
  }
  return { ...swagger, paths: newPaths };
};

// 分组导出可能包含同名但结构不同的 DTO；同时改写定义及引用，避免后一次导出覆盖前一次。
const scopeDefinitions = (swagger, groupIndex) => {
  const names = new Map(
    Object.keys(swagger.definitions || {}).map(name => [name, `Context${groupIndex}_${name}`]),
  );
  const rewrite = value => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        const prefix = "#/definitions/";
        if (key === "$ref" && typeof item === "string" && item.startsWith(prefix)) {
          const name = item.slice(prefix.length);
          return [key, names.has(name) ? `${prefix}${names.get(name)}` : item];
        }
        return [key, rewrite(item)];
      }),
    );
  };
  const result = rewrite(swagger);
  result.definitions = Object.fromEntries(
    Object.entries(result.definitions || {}).map(([name, schema]) => [names.get(name), schema]),
  );
  return result;
};

/**
 * 合并两个 swagger 对象的 paths 和 definitions。
 * 后者的同名 key 会覆盖前者。
 */
const mergeSwagger = (base, addition) => ({
  ...addition,
  paths: { ...base.paths, ...addition.paths },
  definitions: { ...base.definitions, ...addition.definitions },
});

/**
 * 遍历 selectedFolderIds 的每个上下文，逐个请求 apifox 并合并结果。
 * 请求后给所有 path 补全 /${context}/ 前缀。
 * 如果有 --url 参数，在某个上下文中找到所有目标 URL 后提前停止请求。
 */
const fetchSwaggerByApifox = async () => {
  const settings = await loadSettings();
  const apifox = settings.apifox || {};
  const url = apifox.url;
  if (!url) throw new Error("未配置 apifox.url，请检查 fetch-api-setting.json");

  const selectedFolderIds = apifox.selectedFolderIds || [];
  const grouped = !Array.isArray(selectedFolderIds);
  const contexts = grouped ? Object.entries(selectedFolderIds) : [["", selectedFolderIds]];
  if (!contexts.length) throw new Error("未配置 apifox.selectedFolderIds，请检查 fetch-api-setting.json");
  for (const [context, folderIds] of contexts) {
    if (!Array.isArray(folderIds))
      throw new Error(`apifox.selectedFolderIds[${context}] 必须为数组`);
  }

  const targetUrls = parseTargetUrls();
  let mergedSwagger = { paths: {}, definitions: {} };

  for (const [groupIndex, [rawContext, folderIds]] of contexts.entries()) {
    const context = rawContext.replace(/^\/+|\/+$/g, "");
    console.log(`正在请求${context ? `上下文 [${context}]` : "所选文件夹"}的接口数据...`);

    const response = await fetch(url, {
      method: "POST",
      headers: buildApifoxHeaders(apifox),
      body: JSON.stringify(buildApifoxPayload(folderIds, apifox)),
      redirect: "follow",
    });

    if (!response.ok) {
      throw new Error(`请求失败：${response.status} ${response.statusText}`);
    }

    const swagger = await response.json();
    const prefixed = grouped
      ? prependContextToPaths(scopeDefinitions(swagger, groupIndex), context)
      : swagger;
    mergedSwagger = mergeSwagger(mergedSwagger, prefixed);

    // 如果有 --url 且已在当前合并结果中找到所有目标 URL，提前停止
    if (targetUrls.length) {
      const allFound = targetUrls.every(u => mergedSwagger.paths[u]);
      if (allFound) {
        console.log(`在上下文 [${context}] 中找到所有目标 URL，停止请求`);
        break;
      }
    }
  }

  return mergedSwagger;
};

runFetchApiSync(fetchSwaggerByApifox, "apifox").catch(error => {
  console.error("同步失败", error?.message || error);
  process.exit(1);
});
