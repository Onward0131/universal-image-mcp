# 通用图片能力与边界

能力由配置的协议、模型、账号和供应商决定。项目不内置某个站点的成功记录，不把模型目录可见性当成生成能力保证。

|项目|OpenAI Images|Gemini|聊天式图片接口|
|---|---|---|---|
|文生图|JSON POST|generateContent|chat/completions|
|参考图|单张Multipart|单张inlineData|单张image_url|
|每次请求数量|1～4，仍受模型限制|只接受1|只接受1|
|精确像素参数|可发送size，由上游决定|不发送，使用extra_body|不发送，使用extra_body|
|输出格式|可发送png/jpeg/webp，由上游决定|按实际返回字节|按实际返回字节|
|可用结果|Base64、公开URL、图片Data URL|inlineData图片|结构化图片或Markdown图片链接|

参考图最多10MB，支持PNG/JPEG/WebP。暂不支持mask、多参考图、专用异步轮询和任意自定义REST返回结构。

`explain_image_capability`报告当前模型选择和未验证状态。`current_catalog`表示查询了目录，`configured_provider`表示依据当前配置；二者都不宣称尺寸、格式或数量一定可用。

实际输出与请求逐项比较：`count_mismatch`、`size_mismatch`、`format_mismatch`。尺寸变化会附带比例偏差，允许区分等比例降分辨率和比例变化。返回`degraded`时保留图片并解释差异，不自动再次付费生成。

所有生成与编辑提交只执行一次。网络失败和超时不证明没有计费。模型目录可进行有限的只读重试。

已授权的站点实测见[在线测试记录](docs/LIVE-TEST.md)，其结论仅适用于记录的时间、连接、模型和请求参数。
