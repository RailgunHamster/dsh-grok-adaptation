# dsh-grok-adaptation

DeepSeek Harness plugin that normalizes undersized Grok image inputs on the OpenAI Responses HTTP/SSE path.

---

## English

### What it does

The plugin keeps Grok requests on the normal Responses HTTP/SSE path. It does not open or require a WebSocket connection.

For every `input_image` in a Responses `message` or `function_call_output` item, the plugin reads image metadata with Sharp/libvips. If either image edge is 24 pixels or smaller, it:

1. Decode the original image with nearest-neighbor processing.
2. Resize the actual pixels proportionally onto a 32x32 transparent canvas.
3. Add a text note containing the original dimensions and the resulting content dimensions.

Square images fill the canvas. Narrow or rectangular images keep their aspect ratio and receive transparent padding instead of being stretched. Images whose width and height are both greater than 24 pixels are sent unchanged.

Sharp provides one mature decoding path for PNG, JPEG, GIF, WebP, TIFF, AVIF, and other supported formats. The plugin does not maintain separate handwritten image decoders.

### Scope

Image normalization runs only when all of the following are true:

- Endpoint: `/v1/responses` or `/responses`
- Model: starts with `grok-` (configurable via `autoModelPrefixes`)

Optional plugin config:

- `hostnames`: if set, only those hostnames are intercepted; an empty list means any host
- `markerHeader` / `markerValue`: optional route marker, default `x-dsh-grok-adaptation: v2`

The model-prefix check is mandatory. Gemini, Qwen, GPT, web-search, and other non-Grok requests are forwarded unchanged, even if they carry the marker.

### Install

Install the package into the DSH web profile:

```powershell
dsh plugin --profile web add https://github.com/RailgunHamster/dsh-grok-adaptation.git
dsh plugin --profile web install
```

Restart `dsh-web` after installation. The package includes Sharp and its platform binary dependencies.

### Route configuration

Add the marker only to the Grok route:

```yaml
llm-pi-ai:
  providers:
    grok:
      api: openai-responses
      baseURL: https://api.example.com/v1
      apiKeyEnv: GROK_API_KEY
      headers:
        x-dsh-grok-adaptation: v2
```

Do not add this marker to ordinary GPT or web-search provider routes.

To limit interception to one upstream host, set plugin config:

```yaml
- id: grok-adaptation
  config:
    hostnames: ['api.example.com']
    autoModelPrefixes: ['grok-']
```

### Development

The package contains no credentials. It uses the `Authorization` header already created by DSH.

```powershell
pnpm install
pnpm run check
```

The tested cases include Grok 4.6 Responses requests with current-turn images and tool-result image replays, using PNG, JPEG, GIF, WebP, 1x16, 16x26, 16x32, and 16x16 inputs. Undersized images were normalized and the resulting requests completed successfully.

### License

MIT

---

## 中文

### 功能

插件让 Grok 请求继续使用标准 Responses HTTP/SSE，不打开也不依赖 WebSocket。

对于 Responses `message` 或 `function_call_output` 中的每个 `input_image`，插件使用 Sharp/libvips 读取图片信息。如果图片任意一边不超过 24 像素，插件会：

1. 使用最近邻方式解码原图。
2. 按比例把真实像素放大到 32x32 透明画布中。
3. 添加包含原图尺寸和实际内容尺寸的文字备注。

正方形图片会填满画布。窄图或矩形图保持原始比例，使用透明留白，不会被强行拉伸。宽度和高度都大于 24 像素的图片原样发送。

Sharp 为 PNG、JPEG、GIF、WebP、TIFF、AVIF 以及其他支持的格式提供统一且成熟的解码路径。插件不再维护手写的格式专用解码器。

### 作用范围

只有以下条件同时满足时才会进行图片规范化：

- 接口：`/v1/responses` 或 `/responses`
- 模型：名称以 `grok-` 开头（可通过 `autoModelPrefixes` 配置）

可选插件配置：

- `hostnames`：若填写，则只拦截这些主机名；空列表表示不限制主机
- `markerHeader` / `markerValue`：可选路由标记，默认 `x-dsh-grok-adaptation: v2`

实际生效仍以模型前缀为准。即使 Gemini、Qwen、GPT、web search 或其他非 Grok 请求带有该标记，也会原样转发，不会被修改。

### 安装

将插件安装到 DSH web profile：

```powershell
dsh plugin --profile web add https://github.com/RailgunHamster/dsh-grok-adaptation.git
dsh plugin --profile web install
```

安装后重启 `dsh-web`。插件依赖中包含 Sharp 及其对应平台的二进制依赖。

### 路由配置

只给 Grok 路由添加标记：

```yaml
llm-pi-ai:
  providers:
    grok:
      api: openai-responses
      baseURL: https://api.example.com/v1
      apiKeyEnv: GROK_API_KEY
      headers:
        x-dsh-grok-adaptation: v2
```

不要给普通 GPT 或 web-search provider 路由添加这个标记。

如果只想拦截某一个上游主机，可以在插件配置里写：

```yaml
- id: grok-adaptation
  config:
    hostnames: ['api.example.com']
    autoModelPrefixes: ['grok-']
```

### 开发

插件不包含任何凭据，使用 DSH 已经生成的 `Authorization` 请求头。

```powershell
pnpm install
pnpm run check
```

已测试 Grok 4.6 Responses 请求，包括当前轮图片和工具结果图片回放，覆盖 PNG、JPEG、GIF、WebP、1x16、16x26、16x32 和 16x16 图片。小图经过规范化后，请求成功完成。

### 许可证

MIT
