# Wawapi Image MCP

[English](README.en.md)｜简体中文

Wawapi Image MCP让使用纯文本模型API的Codex生成、编辑并显示图片。图片字节由本地stdio MCP处理，Codex只接收结构化文本、本地路径和Markdown，因此主模型API不需要原生图片能力，也不需要接收MCP`image`内容块。

> 本项目是独立的社区集成，不是Wawapi、OpenAI或Codex的官方项目。使用者需要自行取得合法有效的Wawapi API Key，并遵守渠道条款、内容政策和计费规则。

## 三步安装（Windows）

### 安装前准备

- Windows 10或Windows 11。
- 已经可以正常打开Codex，且终端中可以使用`codex`命令。
- 一个已开通图片服务的Wawapi API Key。
- 能访问Node.js官方网站和Wawapi的网络连接。

不需要预装Node.js、npm或PowerShell 7，也不需要管理员权限。`install.cmd`会优先使用`pwsh`；电脑没有`pwsh`时，自动使用Windows自带的Windows PowerShell 5.1。安装器会把固定版本的Node.js官方便携运行时放进本项目安装目录，不修改系统PATH。

### 开始安装

1. 从[GitHub Releases](../../releases/latest)下载`Wawapi-Image-MCP-v<version>.zip`。
2. 解压ZIP，不要直接在压缩包预览窗口中运行文件。
3. 在解压后的文件夹里双击`install.cmd`，按提示输入API Key。首次安装会自动下载并校验受管Node.js运行时，请保持窗口和网络连接，直到显示“安装完成”。
4. 完全关闭并重新打开Codex，然后新建一个任务。

安装器不会显示或记录完整Key。Windows如果阻止脚本，请先确认ZIP来自本项目Release并完成SHA-256校验；不要运行来源不明的副本。

### 第一次生成

在新的Codex任务中输入：

```text
使用$wawapi-image生成一张1024×1024 PNG：白色背景上的红色纸鹤，居中构图，柔和阴影，不要文字。生成后把图片显示在对话中。
```

Codex应先检查MCP，再生成、保存并在对话中显示图片。2K、4K、特殊比例、非PNG、多图或参考图请求会先查询能力证据。

### 常见安装问题

|窗口提示|处理方式|
|---|---|
|Node.js运行时下载失败|确认可以访问`nodejs.org`，检查代理、防火墙或企业网络策略，然后重新双击`install.cmd`|
|Node.js运行时SHA-256校验失败|不要绕过校验；重新运行安装器，持续失败时从本项目GitHub Release重新下载安装包|
|不支持当前Windows架构|当前自动安装支持x64和arm64 Windows|
|未找到Codex命令|安装或更新Codex，并确认终端中运行`codex --version`有结果|
|Key无效|向Key提供方确认鉴权和图片服务权限，然后重新运行安装器|
|模型目录未验证|这是非阻断警告，不等于生图渠道不可用；用户已请求图片时，Skill会继续一次真实生成|
|真实生成返回上游渠道不可用|等待渠道恢复或联系Key提供方；不要修改提示词、尺寸或模型规避|
|安装完成但Codex没有图片工具|完全退出Codex，重新打开并新建任务|
|生成约60秒后显示`MCP error -32001: Request timed out`|这是Codex宿主超时，不是Doctor或上游渠道结论；重新运行最新版`install.cmd`，确认安装摘要显示“MCP工具超时：600秒（已验证：True）”，再完全重启Codex。不要自动重试刚才的请求|

## 项目组成

本仓库只提供两个用户能力：

- `wawapi-image` MCP：调用Wawapi图片接口、保存结果并返回纯文本工具响应。
- `$wawapi-image` Codex Skill：指导Codex检查环境、选择工具、控制计费、解释降级并显示本地图片。

`install.cmd`只是Windows安装入口。仓库不提供网页、桌面程序、EXE、图形界面或独立图片CLI。

## 适用范围

适合以下场景：

- Codex使用的主模型API只支持文本，但Codex宿主能够调用本地MCP工具。
- 主模型不能接收图片工具结果，但可以读取工具返回的文本和文件路径。
- 需要通过自然语言完成文生图、参考图转换、文件保存和对话内回显。

以下场景不适用：

- Agent或宿主完全不支持MCP工具调用。
- 需要主模型直接理解图片视觉内容。本MCP能验证文件格式和尺寸，但不会赋予文本模型视觉能力。
- 需要任意OpenAI-compatible Base URL。本项目将接口固定为`https://wawapii.com/v1`，防止Key被配置重定向。
- 需要非Windows的一键安装。MCP运行时代码可跨平台，但当前安全安装器只正式支持Windows 10和Windows 11。

## 工作原理

```text
用户请求图片
  -> Codex加载$wawapi-image
  -> Codex调用本地stdio MCP
  -> MCP请求Wawapi图片接口
  -> MCP验证并保存真实图片文件
  -> MCP返回纯文本JSON、绝对路径和Markdown
  -> Codex在对话中显示本地文件
```

MCP成功和失败响应都只包含`text`内容块。图片Base64不会进入对话上下文。

## 安装器做什么

安装器会校验内部npm包，下载固定的Node.js v24.19.0 LTS官方便携ZIP并核对内置SHA-256，以掩码方式读取Key，用Windows ACL保护配置，安装Skill，注册MCP，把Codex的该MCP工具超时设为600秒并反读验证，然后通过真实stdio会话执行只读Doctor。运行依赖已经打进Release中的npm包，安装时不会再从npm仓库解析或下载依赖。Codex默认MCP工具超时为60秒，真实生图可能超过该时间，因此这一步不能省略。

Codex官方[配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)将`mcp_servers.<id>.tool_timeout_sec`定义为覆盖默认60秒工具超时的设置。本项目只修改`wawapi-image`自己的配置段。

默认安装位置是`D:\CodexTools\wawapi-image-mcp`；没有D盘时使用`%LOCALAPPDATA%\CodexTools\wawapi-image-mcp`。受管Node.js位于该目录的`runtime`子目录，MCP启动器始终显式调用它，因此电脑没有Node.js、只有旧版Node.js或PATH尚未刷新都不影响使用。安装器不会修改用户`PATH`。

安装器只更新空目录、带有效所有权标记的安装目录，或可确认属于旧版本的安装目录；不会覆盖或卸载无法确认归属的普通目录。

## 命令行安装与校验（高级）

Release同时提供`Wawapi-Image-MCP-v<version>.zip.sha256`。解压前可以核对：

```powershell
Get-FileHash -LiteralPath .\Wawapi-Image-MCP-v1.3.0.zip -Algorithm SHA256
Get-Content -LiteralPath .\Wawapi-Image-MCP-v1.3.0.zip.sha256
```

`install.cmd`支持把参数继续传给安装器：

```powershell
.\install.cmd -InstallRoot "E:\CodexTools\wawapi-image-mcp"
```

在受限网络中，也可以预先从Node.js官方网站下载与本机架构匹配的`node-v24.19.0-win-x64.zip`或`node-v24.19.0-win-arm64.zip`，再让安装器校验并使用本地副本：

```powershell
.\install.cmd -NodeRuntimeArchive ".\node-v24.19.0-win-x64.zip"
```

安装器固定接受的官方SHA-256如下：

|架构|文件|SHA-256|
|---|---|---|
|x64|`node-v24.19.0-win-x64.zip`|`57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73`|
|arm64|`node-v24.19.0-win-arm64.zip`|`8502f4a50b458d4cc38ed8f2001556c2cd239d464920f74017926ccb1e1c157f`|

也可以直接使用系统自带的Windows PowerShell：

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 `
  -InstallRoot "E:\CodexTools\wawapi-image-mcp"
```

自定义安装目录的末级名称必须是`wawapi-image-mcp`，完整路径不能超过100个字符。直接运行`install.ps1`时结果为JSON；双击入口使用适合人工阅读的结果。

## MCP工具

|工具|用途|调用生图接口|
|---|---|---|
|`image_doctor`|检查本地运行时与Key，并可选探测只读模型目录；不探测真实生图渠道|否|
|`list_image_models`|列出当前上游可见的图片模型|否|
|`explain_image_capability`|解释模型选择及尺寸、格式、数量和参考图的实测边界|否|
|`generate_image`|文生图并保存本地文件|是，可能计费|
|`edit_image`|读取本地参考图并生成新图片|是，可能计费|
|`inspect_image`|检查本地图片的真实格式、像素、字节数和SHA-256|否|

`generate_image`和`edit_image`返回`data.result.images[]`。每项包含：

- `path`：绝对本地路径。
- `file_uri`：标准文件URI。
- `markdown`：可直接回显的Markdown。
- `width`、`height`和`size`：从文件内容识别的真实像素。
- `format`：从文件头识别的真实格式。
- `bytes`和`sha256`：完整性信息。

`status=exact`表示数量、尺寸和格式全部匹配请求；`status=degraded`表示文件有效，但至少一项发生降级，必须查看`deviations`并按实际结果描述。

### 正确理解Doctor

- `ready=true`表示本地MCP具备尝试一次用户已授权生图请求的条件，不代表上游生成渠道一定健康。
- `catalog_status=verified`只证明`/models`只读目录响应成功。
- `catalog_status=unverified`是非阻断状态，可能来自DNS、代理、TLS、超时、网关错误或目录接口自身误报。此状态不能写成“生图渠道不可用”。
- Doctor不发送可能计费的生成请求，因此`generation_channel_status`固定为`not_probed`。
- 只有`generate_image`或`edit_image`从`generation_submit`、`edit_submit`或`generation_poll`阶段返回`upstream_channel_unavailable`，才构成真实生图渠道不可用的证据。
- Doctor通常很快完成，不能验证长耗时生图是否会被宿主提前终止。最新版安装器会单独把Codex的`tool_timeout_sec`设为600并反读验证。

## 模型与输出边界

随仓库发布的能力快照记录截至2026-08-04的实测结果。它是时间点证据，不是永久服务承诺。

- 文生图`auto`优先`gpt-image-2-high`。
- 参考图`auto`优先`gpt-image-2`。
- 用户显式指定模型时不会静默切换。
- `gpt-image-2-high`、`gpt-image-2-medium`和`gpt-image-2-low`已有1024×1024、2048×2048和3840×2160精确文生图证据。
- 基础`gpt-image-2`曾把2048×2048降为1254×1254；2026-08-04两次最新真实3840×2160请求均返回2048×1152，历史也曾返回1672×941或精确4K。保持比例不等于达到请求分辨率。
- 输出支持PNG、JPEG和WebP，但上游可能忽略格式；MCP始终按真实文件头保存和报告。
- 单次数量为1到4。上游可能把多图请求降为较少文件或拼图，必须检查`actual_count`。
- 同一基础模型的`count=2、1024×1024、JPEG`请求在2026-08-04先返回1张1254×1254 PNG，后返回2张独立1024×1024 PNG；多图数量和像素会波动，两次都发生JPEG到PNG的格式降级。
- 多图请求调用`explain_image_capability`时必须传入`count`；返回的`requestedCount`、`expectedCountStatus`和证据中的`actualCount`会明确区分单图与多图能力。
- `selection_scope=current_catalog`是当前目录感知选择；`offline=true`得到的`bundled_baseline`只是历史证据。两者模型不同时，不能把历史模型写成当前`auto`结果。
- 参考图支持PNG、JPEG和WebP，最大10 MB。
- 一次HTTP502/503/524只表示瞬时状态，不能证明模型永久不支持某项能力。

完整的模型、尺寸、比例、格式和参考图证据见[完整能力与降级表](CAPABILITIES.md)。

## 错误契约

|错误码|含义|处理方式|
|---|---|---|
|`api_key_missing`|没有可用Key|重新运行安装器并使用`-ResetApiKey`|
|`invalid_api_key`|Key无效、过期或没有通过鉴权|更新Key并确认已开通图片服务|
|`upstream_channel_unavailable`|真实生成接口明确表示Key对应的图片渠道当前不可用|等待恢复或联系Key提供方；不要修改提示词、尺寸或模型来规避|
|`model_catalog_unverified`|只读模型目录没有得到可靠结论|不要当成渠道故障；用户已请求图片时继续一次真实生成|
|`network_error`|网络层失败，附带`network_category`、`cause_code`和`phase`|按DNS、拒绝连接、重置、超时、TLS、代理或路由分类排查，不要改写成渠道不可用|
|`rate_limit`|上游明确限流|等待限流窗口，不连续提交|
|`upstream_error`|普通HTTP502/503等瞬时故障|由用户稍后决定是否重新授权请求|
|`upstream_timeout`|HTTP524或本地等待超时|不要自动重放，计费状态可能不明确|
|`unsupported_size`|上游明确拒绝尺寸|改用1024×1024或先查询能力|
|`reference_image_not_found`|本地参考图路径不存在；请求尚未触达上游|检查路径或重新提供PNG、JPEG、WebP文件，不要排查API Key|
|`invalid_reference_image`|本地文件不是有效的PNG、JPEG或WebP；请求尚未触达上游|换用有效图片文件，不要把它解释为上游渠道故障|
|`image_not_found`/`invalid_image_file`|`inspect_image`找不到文件或文件不是支持的图片|检查本地路径和真实文件格式|
|`reference_request_misparsed`|参考图路由没有正确解析已发送的提示词|保留提示词；新的尝试需要用户重新授权|
|`model_unavailable`|指定模型不在当前目录|先查询模型目录，再选择返回的模型或使用`auto`|

“Key无效”“模型目录未验证”“网络连接失败”和“真实生图渠道不可用”是四种不同状态。MCP会保留探测阶段、目标路径、尝试次数、HTTP状态、网络分类和安全的底层错误码，避免把目录或本机网络问题误判成生图渠道故障。

`MCP error -32001: Request timed out`是Codex宿主在MCP返回前停止等待，不是上述MCP错误契约中的`upstream_timeout`。最新版安装器会按Codex官方支持的`tool_timeout_sec`配置将该MCP设为600秒；若仍出现此消息，不要把它写成渠道不可用，也不要未经重新授权就再次提交可能计费的请求。

## 安全、隐私与计费

- Base URL固定为`https://wawapii.com/v1`，配置文件和环境变量都不能更改它。
- MCP优先读取受ACL保护的状态配置；仅在配置不存在时读取`WAWAPI_API_KEY`，永远不读取`OPENAI_API_KEY`。
- 安装包、源码、工具响应和日志不应包含Key、Authorization头、图片Base64或完整上游响应。
- 提示词和参考图会发送给Wawapi。若上游返回图片URL，MCP会从该公开地址下载结果，并拒绝本机、私网、链路本地地址和不安全重定向。
- 项目没有遥测。运行时网络请求仅用于Wawapi模型/图片接口和上游返回的公开图片下载地址。
- 安装器只从固定的Node.js官方HTTPS地址下载受管运行时，并对x64/arm64归档使用内置SHA-256校验；校验失败即停止。
- 用户明确请求生成或编辑图片，只代表授权一次可能计费的调用，不代表授权额外变体或无限重试。
- MCP最多只在上游明确表示尚未接单时安全重试一次，例如限流或没有可用渠道。
- 普通502/503/524、网络中断、本地超时和宿主取消不会自动重放。
- 输出目标已存在时会创建不冲突的新文件名，不覆盖用户文件。

不要把Key写入Codex项目、`config.toml`、README、Issue或聊天记录。若Key曾被公开，立即在渠道侧撤销或轮换。

## 更新、修改Key与卸载

更新时解压新版本并再次双击`install.cmd`。安装器会验证发布包、保留现有Key、更新MCP和Skill，然后再次执行只读自检。

修改Key：

```powershell
.\install.cmd -ResetApiKey
```

卸载：

```powershell
.\install.cmd -Uninstall
```

卸载器只删除可确认属于本项目的安装目录、MCP注册和Skill联接。安装目录中的受保护Key会一并删除，无法从项目恢复。

## 常见问题

### Codex中没有图片工具

打开新的Codex任务。仍不可用时运行`codex mcp list`并确认存在`wawapi-image`；缺失时重新运行安装器。

### `image_doctor`返回`ready=false`

查看`issues`或安装器的`doctor_issues`。`ready=false`一定会附带至少一个阻断项，常见原因是Key缺失、Key明确鉴权失败或本地运行时损坏。最新版安装器会自行配置Node.js，不需要另开任务手工安装Node.js。

### `image_doctor`显示模型目录未验证

查看顶层`warnings`中的`probe_error`。其中会标明`phase`、`target_path`、`attempts`、`status`、`network_category`和`cause_code`。这是非阻断状态；Doctor没有调用真实生图接口，不能据此判断渠道不可用。若用户已经明确请求图片，Skill应继续一次真实生成。

### 生成成功但对话中没有图片

要求Codex使用返回的`images[].markdown`显示文件。只报告“生成成功”而不显示或链接文件，属于未完成。

### 生图约60秒后超时

如果消息是`MCP error -32001: Request timed out`，说明Codex仍在使用默认或旧的宿主超时配置。重新运行最新版`install.cmd`，检查安装摘要中的`MCP工具超时`为600秒且已验证，然后完全退出并重新打开Codex。上一次请求是否已被上游接收或计费无法从宿主超时判断，因此不要自动重试。

### 文本模型能判断图片画得是否正确吗

不能。`inspect_image`只能验证文件头、尺寸、格式、字节数和SHA-256。没有视觉输入能力的模型必须把文件验证与视觉审查明确区分。

## 从源码验证和构建

以下命令只面向贡献者；使用GitHub Release双击安装的用户不需要系统Node.js或npm。

```powershell
npm ci
npm test
npm pack --dry-run
npm run build:release
```

发布物生成在`release`目录，包括版本化ZIP、ZIP的独立SHA-256文件和内部文件校验表。离线测试不需要Key，也不会调用Wawapi。`verify:live`会产生真实图片请求，可能计费，只有Key所有者明确授权时才能运行。

贡献前请阅读[CONTRIBUTING.md](CONTRIBUTING.md)，安全问题按[SECURITY.md](SECURITY.md)私下报告。版本变化见[CHANGELOG.md](CHANGELOG.md)。

## 许可证

代码以[MIT License](LICENSE)开源。Wawapi、OpenAI、Codex及相关模型名称归各自权利人所有；本许可证不授予第三方商标权，也不改变外部服务条款。
