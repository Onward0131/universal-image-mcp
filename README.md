# Universal Image MCP for Codex

[English](README.en.md)｜简体中文

在Codex中通过你选择的官方或第三方API生成、编辑并显示图片。MCP在本地处理图片字节，只返回纯文本JSON、绝对文件路径和Markdown，主模型API无需接收图片工具内容块。

项目、npm包与命令名：`universal-image-mcp`；MCP与Skill名：`universal-image`。没有默认第三方地址或默认图片模型，必须明确配置连接。

## 新手上手示例

先按[Windows安装](#windows安装)完成配置，或把本项目地址发给Codex，让它协助完成安装步骤。配置完成后重启Codex，新建任务，描述你想生成的图片即可。下图展示了配置、自检和在对话中显示生成图片的流程：

![Codex配置通用图片MCP、完成自检并生成图片的操作示例](docs/images/codex-quickstart.png)

截图中的Base URL与Key已遮挡。实际配置时，通过安装器的掩码提示输入Key；模型和图片尺寸以所选供应商的实际结果为准。

## 支持哪些API

|协议|典型服务|文生图|参考图编辑|
|---|---|---|---|
|OpenAI Images|OpenAI官方、兼容此协议的第三方网关|支持|支持单张Multipart参考图|
|Gemini generateContent|Gemini原生接口及兼容网关|支持|支持inlineData参考图|
|OpenAI Chat图片输出|OpenRouter及兼容网关|支持|支持image_url参考图|

支持自定义Base URL、模型、Bearer/请求头/无Key鉴权、路由、查询参数、额外请求头和扩展JSON。协议适配不等于任意供应商或模型都已实测；专用异步任务、ComfyUI工作流和OAuth服务需要专门适配。

- [供应商配置与示例](docs/PROVIDERS.md)
- [完整能力与降级表](CAPABILITIES.md)
- [授权在线测试记录](docs/LIVE-TEST.md)
- [工程评估与后续方向](docs/ASSESSMENT.md)

## Windows安装

需要Windows10/11、可运行`codex`的Codex安装，以及图片服务账号或可信本地网关。不需要预装Node.js、npm或PowerShell 7，也不需要管理员权限。安装入口优先使用PowerShell7，未安装时兼容Windows内置PowerShell5.1。

1. 从[Releases](https://github.com/Onward0131/universal-image-mcp/releases/latest)下载`Universal-Image-MCP-v2.0.0.zip`并解压。
2. 双击解压目录中的`install.cmd`，选择供应商并填写完整Base URL、图片模型ID和API Key。
3. 等待安装完成，再完全关闭并重新打开Codex，新建任务。

Base URL包含供应商要求的版本前缀，例如`https://your-provider.example/v1`。不会自动添加`/v1`。OpenAI、Gemini和OpenRouter预设提供对应服务地址，仍需指定实际可用的图片模型。

PowerShell7中也可直接执行：

```powershell
.\install.ps1 -Provider openai-compatible -BaseUrl "https://your-provider.example/v1" -Model "your-image-model"
```

Key通过掩码提示输入。完整JSON配置可用`-ProviderConfigPath`导入；环境变量引用会转发变量名到Codex，不把变量值复制到Codex配置。无Key本地网关使用`auth_type: "none"`。

安装器下载并校验官方Node.js24.19.0便携运行时，离线安装包内依赖，保护状态目录权限，注册MCP与Skill，并将MCP工具超时设为600秒后反读验证。默认安装在`D:\CodexTools\universal-image-mcp`；没有D盘则使用`%LOCALAPPDATA%\CodexTools\universal-image-mcp`。不修改系统PATH。

```powershell
Get-FileHash -LiteralPath .\Universal-Image-MCP-v2.0.0.zip -Algorithm SHA256
Get-Content -LiteralPath .\Universal-Image-MCP-v2.0.0.zip.sha256
```

## 在Codex中使用

```text
使用$universal-image生成一张图片：白色背景上的红色纸鹤，居中构图，柔和阴影，不要文字。生成后把图片显示在对话中。
```

编辑时给出本地图片绝对路径和具体修改要求。当前参考图限单张PNG/JPEG/WebP、最大10MB；不支持mask或多参考图。

|工具|用途|可能计费|
|---|---|---|
|`image_doctor`|检查配置、鉴权和可选模型目录|否|
|`list_image_models`|查询当前连接的模型目录|否|
|`explain_image_capability`|解释模型选择和参数限制，不作未验证能力保证|否|
|`generate_image`|生成并保存图片|是|
|`edit_image`|提交参考图编辑并保存图片|是|
|`inspect_image`|检查本地文件格式、尺寸和哈希|否|

Doctor的`generation_channel_status=not_probed`表示没有提交生图请求。模型目录暂时不可用不会单独证明生图渠道不可用；已有明确模型且鉴权未被拒绝时仍可执行用户授权的一次调用。

`model=auto`使用配置模型，或目录中唯一可识别的图片候选。多个候选时不会猜测。显式模型不会被不完整目录拦截。通用工具不默认发送质量、格式、背景等可选参数；支持范围由实际协议和模型决定。

所有生图和编辑请求均只提交一次；不因503、429、超时或网络中断自动重试、换模型或换供应商。返回的实际像素、格式和数量与请求不一致时会标记`degraded`并保留结果。

## 升级与迁移

v2.0.0是破坏性更新：包、入口文件、安装目录、状态目录、MCP和Skill都使用通用名称。v1.x的专属环境变量、隐式地址、历史选型策略与能力快照不再使用。

从v1.x迁移时，先保存必要配置，再用旧版安装器卸载旧实例，随后安装v2.0.0并显式选择供应商。不要把旧配置文件中的Key直接与新地址拼接；请按新格式导入完整连接。历史版本保留在Git标签和旧Release中。

v2.x更新时重新运行新版安装器，无参数更新保留完整配置。`-Model`修改模型；`-ResetApiKey`更新Key；切换地址或供应商时清除旧连接的鉴权与路由。

```powershell
.\install.ps1 -Uninstall
```

卸载仅移除可验证归属的当前安装、MCP注册和Skill链接，不删除生成图片。

## 源码与多供应商

Node.js22或更高版本运行`npm ci`后，参考[Codex手动配置](docs/PROVIDERS.md#codex源码接入与多供应商)。macOS/Linux可运行Node源码；自动安装器目前面向Windows。多个MCP实例可用不同配置文件和Key，并在任务中指定目标实例。

## 常见问题

- `base_url_required`：配置完整Base URL，或选择一个明确的供应商预设。
- `model_required`：填写供应商控制台或模型目录返回的实际图片模型ID。
- `invalid_api_key`：确认Key与当前站点匹配，并具有图片服务权限。
- `missing_header_env`：确保启动Codex的环境能访问所引用变量，仅在其他终端中设置不会传给已有桌面进程。
- `MCP error -32001: Request timed out`：这是宿主超时，检查600秒配置并重启Codex。上一请求计费状态未知，不要自动重试。
- 实际尺寸/格式不符：查看`data.result.deviations`；MCP不会偷偷转码、裁切或提交第二次请求。
- 图片URL为内网地址：结果下载仍拒绝私网、回环和不安全跳转。可让本地网关直接返回Base64。

## 开发验证

```powershell
npm ci
npm test
npm audit --omit=dev --audit-level=moderate
.\scripts\build-release.ps1
```

离线测试不访问图片供应商。`scripts/live-mcp-smoke.mjs`会提交真实计费请求，仅在Key所有者授权后使用。测试与密钥文件不能进入提交。

本项目是独立社区集成，采用[MIT License](LICENSE)，不是任何API供应商或Codex的官方项目。
