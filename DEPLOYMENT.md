# AI 后端部署（Deno Deploy）

GitHub Pages 只托管静态网页，不能保存 API Key。AI 出题通过 Deno Deploy 上的后端（`api/index.js`）调用 DeepSeek；网页只保存你自己设置的后端访问口令。

## 发布后端

1. 仓库根目录 `api/index.js` 即 Deno 后端入口（`deno.json` 指定 `main: api/index.js`）。
2. 在 Deno Deploy 导入 `nb66666708/c-stm32-learning` 仓库并关联 `main` 分支；若未关联仓库，可在面板直接粘贴 `api/index.js` 手动部署。
3. 在项目 **Settings → Environment Variables** 中设置：
   - `DEEPSEEK_API_KEY`：DeepSeek 开放平台创建的 API Key（必填）。
   - `DEEPSEEK_MODEL`：可选，默认 `deepseek-flash`（非思考档）。
   - `SITE_API_TOKEN`：至少 32 个字符的随机长口令，用于限制谁能调用网站后端；它不是 DeepSeek API Key，不要把生成结果发到聊天或截图中。个人自用也可以不配置，但公网建议开启。
   - `ALLOWED_ORIGINS`：允许的网页来源，默认 `https://nb66666708.github.io`，多个用逗号分隔。
4. 部署完成后复制 Deno Deploy 服务的 HTTPS 地址，打开网站的 **配置 AI 后端**，粘贴地址和 `SITE_API_TOKEN`，点击“测试并保存”。健康检查成功后即可生成挑战题。

不要把以上任一密钥提交到 GitHub、写进 `index.html`、聊天消息或截图中。如果误公开了 API Key，请立即到 DeepSeek 平台撤销并重新生成。

## 使用说明

- 后端默认使用 `deepseek-flash`，请求体固定关闭思考模式（`thinking: {type: "disabled"}`）以缩短出题耗时；模型按 token 计费，余额、并发与限流以 DeepSeek 账号后台和官方价格页为准。
- 公开网页不包含 DeepSeek API Key。后端同时校验 GitHub Pages 来源、访问口令并限制请求频率；访问口令请勿分享。
- 网站配置把后端访问口令保存在当前设备浏览器的本地存储中，不要在公用设备上保存。
- 每次生成会把课程资料发送给 DeepSeek。AI 生成题目仍需结合课程内容核对。
- `server.py`、`render.yaml` 是早期 Render / Python 变体，当前线上 Deno Deploy 后端未使用，仅作历史保留。

## 官方文档

- [DeepSeek 对话补全接口](https://api-docs.deepseek.com/api/create-chat-completion)
- [DeepSeek 模型与价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)
