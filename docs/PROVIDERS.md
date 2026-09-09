# 通用供应商配置

v2.0.0统一使用`universal-image-mcp`包名和`universal-image`MCP/Skill名称。每个MCP进程绑定一个明确配置的连接；没有默认第三方域名或默认图片模型。多供应商使用不同配置文件和MCP注册。

## 支持范围

|协议|配置|文生图|参考图|结果格式|
|---|---|---|---|---|
|OpenAI Images及同协议第三方|`api_format: openai-images`|JSON POST|单张参考图Multipart POST|`data[].b64_json`、`data[].url`，URL也可为图片Data URL|
|Gemini原生generateContent|`api_format: gemini`|文本parts|文本+inlineData|`candidates[].content.parts[].inlineData`|
|OpenRouter等聊天式生图|`api_format: openai-chat`|messages|messages中的image_url|`message.images`、结构化image_url或Markdown图片链接|

这是协议适配范围，不是“所有第三方API均已实测”的承诺。供应商必须提供相应协议、图片模型及权限。不自动适配任意REST协议、任意异步任务轮询、Replicate/fal/ComfyUI工作流或Vertex AI OAuth。Azure等按部署划分的Images接口可配置路径、`api-version`查询参数和`api-key`请求头；具体部署需另行验证。

OpenAI Images接口每次请求`count`为1～4，具体上限以模型为准。Gemini和聊天适配器每次只接受`count=1`，不会通过循环提交多个计费请求实现批量。编辑当前只接受一张PNG/JPEG/WebP，最大10MB，暂不支持遮罩或多参考图。

## Windows安装

双击`install.cmd`后可选择供应商、填写Base URL和模型ID。已有安装无参数更新时保留整个配置，包括自定义请求参数；切换供应商或地址时，不继承旧连接的Key、鉴权头及路由。

PowerShell 7中直接执行：

```powershell
.\install.ps1 -Provider openai-compatible -BaseUrl "https://your-provider.example/v1" -Model "your-image-model"
```

Key由安装器掩码提示输入。高级配置可通过`-ProviderConfigPath`导入完整JSON；该文件必须是可信的本地配置。安装器校验后写入受ACL保护的状态目录，并将`api_key_env`和`header_env`引用的变量名写入Codex的`env_vars`，不复制变量值。相关环境变量也必须在启动Codex的环境中可见；仅在某个临时终端内设置的变量不会自动出现在已有的桌面进程中。`-Model`可独立更新模型；`-ResetApiKey`更新当前连接Key。不要在命令行参数或聊天中传Key。

## 配置文件与优先级

推荐使用`IMAGE_MCP_CONFIG`指定绝对JSON路径。否则查找`IMAGE_MCP_HOME/config.json`；默认仍为`~/.universal-image-mcp/config.json`。安装器管理的状态位于安装目录`state/config.json`，并将该绝对路径写入MCP注册，避免其他全局配置环境变量覆盖当前连接。显式指定但不存在的配置文件会报错，不会回退到其他连接。

配置文件中的连接字段作为整体优先于连接环境变量。已有受保护Key时，单独设置环境变量Base URL不会重定向旧Key。切换已安装的连接应修改完整配置，或使用安装器连接参数。

无连接配置文件时，可设置：

|变量|用途|
|---|---|
|`IMAGE_API_PROVIDER`|`openai`、`openai-compatible`、`gemini`、`openrouter`|
|`IMAGE_API_BASE_URL`|完整API前缀；保留`/v1`、`/api/v1`、部署路径等，不自动添加版本|
|`IMAGE_API_MODEL`|实际图片模型ID或部署名|
|`IMAGE_API_FORMAT`|`openai-images`、`openai-chat`、`gemini`|
|`IMAGE_API_KEY`|通用供应商Key|
|`IMAGE_OUTPUT_DIR`|未指定输出路径时的本地目录|

`IMAGE_API_KEY`用于用户明确配置的连接。`OPENAI_API_KEY`仅自动用于显式`provider=openai`且域名为`api.openai.com`；`GEMINI_API_KEY`仅自动用于显式Gemini官方连接。第三方应使用`api_key_env`或`IMAGE_API_KEY`。缺少连接配置返回`base_url_required`，不会擅自发送Key。

## 配置示例

示例文件位于`examples/`，Key均通过环境变量引用。模型名称应从相应供应商控制台确认；不会静默替换用户填写的模型。

OpenAI官方Images接口：

```json
{
  "provider": "openai",
  "model": "your-openai-image-model",
  "api_key_env": "OPENAI_API_KEY"
}
```

任意OpenAI Images兼容站点：

```json
{
  "provider": "openai-compatible",
  "base_url": "https://your-provider.example/v1",
  "model": "your-image-model",
  "api_key_env": "MY_IMAGE_KEY",
  "probe_models": false
}
```

`probe_models=false`用于不提供模型目录或目录权限与生图权限分离的服务。Doctor仍报告`generation_channel_status=not_probed`。`auto`使用配置模型；未配置时只在目录有唯一图片候选ID时选择。没有可靠选择返回`model_required`，不猜测任何供应商型号。显式模型不会被不完整的第三方模型目录拦截。

Gemini原生接口：

```json
{
  "provider": "gemini",
  "model": "your-gemini-image-model",
  "api_key_env": "GEMINI_API_KEY",
  "extra_body": {
    "generationConfig": {
      "imageConfig": { "aspectRatio": "16:9", "imageSize": "2K" }
    }
  }
}
```

Gemini默认使用`x-goog-api-key`请求头；模型可带或不带`models/`前缀。`imageConfig`的可用值取决于实际模型。思考阶段图片不会作为最终结果保存。

OpenRouter聊天式生图：

```json
{
  "provider": "openrouter",
  "model": "vendor/image-model",
  "api_key_env": "OPENROUTER_API_KEY",
  "extra_body": { "modalities": ["image", "text"] }
}
```

Gemini和聊天接口不接受Images API专属尺寸/格式参数：调用时省略`size`和`format`或设置为`auto`；用`extra_body`配置对应供应商的比例、分辨率等。如果用户要求精确像素或格式，应说明该路由的限制，不静默抹去要求。实际文件尺寸和格式始终从返回字节检测。

## 自定义接口与鉴权

```json
{
  "provider": "openai-compatible",
  "base_url": "https://your-resource.example/openai/deployments/art",
  "model": "art",
  "api_key_env": "MY_IMAGE_KEY",
  "auth_type": "header",
  "auth_header": "api-key",
  "query": { "api-version": "your-supported-api-version" },
  "probe_models": false,
  "endpoints": {
    "generations": "/images/generations",
    "edits": "/images/edits"
  },
  "extra_body": { "seed": 42 },
  "omit_fields": ["moderation"],
  "timeout_ms": 300000
}
```

- `endpoints`支持`models`、`generations`、`edits`、`chat`、`generate_content`。路径拼接在Base URL后；Gemini路径支持`{model}`占位符。只允许以单个`/`开头的相对路径，拒绝跨域、查询字符串和`..`。
- `auth_type`支持`bearer`、`header`或显式`none`。本地无Key网关可用`none`，运行时忽略API Key，安装器不保留Key及其环境变量引用。`headers`用于静态非敏感头；`header_env`将头名称映射为环境变量名称。不得覆盖鉴权及HTTP传输头。
- `extra_body`添加JSON参数；明确传入的标准工具参数优先。禁止覆盖模型、提示词、图片、消息、数量或开启流式请求。Multipart扩展对象序列化为JSON字段。
- `omit_fields`只允许省略可选的尺寸、质量、格式、压缩、背景、moderation和response_format字段，不允许丢弃提示词或模型。它是用户配置的兼容性取舍，不会在收到HTTP错误后自动试参数。
- 默认不发送`quality`、`background`、`moderation`、`output_format`或`response_format`。GPT Image一般不需要`response_format`；DALL-E的`standard`/`hd`可作为quality传入，限制以实际模型为准。
- Base URL必须是无用户信息、查询及片段的HTTP(S)URL。远程明文HTTP需显式`allow_insecure_http=true`；回环地址允许HTTP。配置的API端点可为可信内网网关；上游返回的图片下载URL仍拒绝私网和回环地址。
- API请求不跟随重定向；请填写最终服务地址。JSON响应上限为100MB，模型目录上限为5MB，公开图片URL下载上限为50MB。
- 所有生图和编辑提交均不自动重试，普通超时、渠道拒单和网络中断也不会自动重放。

## Codex源码接入与多供应商

安装Node.js22或更高版本后执行`npm ci`。把以下条目合并到Codex配置中，将路径改为自己的绝对路径：

```toml
[mcp_servers.universal-image]
command = "C:/Program Files/nodejs/node.exe"
args = ["D:/tools/universal-image-mcp/bin/universal-image-mcp.mjs"]
tool_timeout_sec = 600
env_vars = ["MY_IMAGE_KEY"]

[mcp_servers.universal-image.env]
IMAGE_MCP_CONFIG = "D:/private/image-provider.json"
```

将`skills/universal-image`放入Codex技能目录。macOS/Linux使用本机Node绝对路径和POSIX绝对配置路径，MCP代码可跨平台运行；双击安装器目前只覆盖Windows。配置文件中如直接存Key，请限制文件权限。

多供应商可以复制此配置段，使用不同MCP名称、`IMAGE_MCP_CONFIG`和`env_vars`。同时注册时，在对话中指定目标MCP；不要把两个站点的Key混用。

本地只读校验不发起生图：

```powershell
node scripts/check-config.mjs D:/private/image-provider.json
```

配置错误会以`isError=true`和纯文本JSON返回，不会破坏stdio。工具结果含绝对文件路径和Markdown，不把Base64发给主模型。

## 接口依据

适配实现核对日期：2026-09-09。

- [OpenAI图像生成](https://developers.openai.com/api/docs/guides/image-generation)
- [Codex MCP配置](https://developers.openai.com/codex/mcp)
- [Gemini图像生成](https://ai.google.dev/gemini-api/docs/image-generation)
- [OpenRouter图像生成](https://openrouter.ai/docs/guides/overview/multimodal/image-generation)

离线契约测试验证本项目发包、解析、落盘和错误边界；蜂巢接口的授权实测记录见`docs/LIVE-TEST.md`；其他供应商仍为离线协议验证。供应商型号、账号权限和在线可用性仍需部署后验证。
