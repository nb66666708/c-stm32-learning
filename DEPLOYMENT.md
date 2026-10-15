# 智谱 AI 后端部署

GitHub Pages 只托管静态网页，不能保存智谱 API Key。AI 出题通过 Render 上的 Python 后端调用智谱；网页只保存你自己设置的后端访问口令。

## 发布后端

1. 把 `index.html`、`server.py` 和 `render.yaml` 放在 GitHub 仓库根目录。
2. 登录 Render，选择 **New → Blueprint**，连接 `nb66666708/c-stm32-learning` 仓库并部署。
3. Render 根据 `render.yaml` 创建服务，并要求填写两个仅保存在 Render 的环境变量：
   - `ZHIPU_API_KEY`：在智谱开放平台创建的 API Key。
   - `SITE_API_TOKEN`：另设至少 32 个字符的随机长口令，用于限制谁能调用你的网站后端。它不是智谱 API Key。可在本机 PowerShell 运行 `python -c "import secrets; print(secrets.token_urlsafe(32))"` 生成；不要把生成结果发到聊天或截图中。
4. 部署完成后复制 Render 服务的 HTTPS 地址，例如 `https://c-stm32-learning-api.onrender.com`。
5. 打开 GitHub Pages 网站的 **配置 AI 后端**，粘贴 Render 地址和 `SITE_API_TOKEN`，点击“测试并保存”。健康检查成功后即可生成挑战题。

不要把以上任一密钥提交到 GitHub、写进 `index.html`、聊天消息或截图中。如果误公开了 API Key，请立即到智谱平台撤销并重新生成。

## 使用说明

- 后端默认使用 `glm-4.7-flash`，可通过 Render 环境变量 `ZHIPU_MODEL` 更改。
- 智谱官方文档目前将 GLM-4.7-Flash 列为免费文本模型；免费资格、调用频率、每日额度及服务规则以账号后台和官方价格页为准，不保证永久免费。
- Render 免费服务可能在空闲后休眠；首次请求需要等待服务唤醒。
- 公开网页不包含智谱 API Key。后端同时校验 GitHub Pages 来源、访问口令并限制请求频率；访问口令请勿分享。
- 网站配置把后端访问口令保存在当前设备浏览器的本地存储中。不要在公用设备上保存；如果口令疑似泄露，应在 Render 更新 `SITE_API_TOKEN`，然后重新配置网页。
- 每次生成会把课程资料发送给智谱。AI 生成题目仍需结合课程内容核对。
- GitHub Pages 版的标准 C 在线判题仍不可用；它需要额外判题后端。
- 本地启动脚本也可选择智谱，并在终端安全输入 API Key；密钥不会保存到项目文件。

## 官方文档

- [智谱 HTTP API 调用](https://docs.bigmodel.cn/cn/guide/develop/http/introduction)
- [模型概览与免费模型列表](https://docs.bigmodel.cn/cn/guide/start/model-overview)
- [智谱 API 定价说明](https://docs.bigmodel.cn/cn/guide/start/pricing)
