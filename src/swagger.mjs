import { runFetchApiSync, loadSettings } from "./shared.mjs";

// 调用例子：
//   cnhis-fetch-api swagger --url /catalog/xxx/yyy
//   cnhis-fetch-api swagger --url /catalog/xxx/yyy --url /catalog/aaa/bbb --keep-api-json

const fetchSwaggerByUrl = async () => {
  const settings = await loadSettings();
  const url = settings.swagger?.url;
  if (!url) throw new Error("未配置 swagger.url，请检查 settings.json");

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`请求失败：${response.status} ${response.statusText}`);
  }
  return response.json();
};

runFetchApiSync(fetchSwaggerByUrl, "swagger").catch(error => {
  console.error("同步失败", error?.message || error);
  process.exit(1);
});
