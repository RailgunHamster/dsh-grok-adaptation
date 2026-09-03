# dsh-grok-adaptation

DeepSeek Harness adaptation for Grok image inputs through the NiuMa/Sub2API OpenAI Responses endpoint.

通过 NiuMa/Sub2API 的 OpenAI Responses 接口，为 DeepSeek Harness 的 Grok 图片输入提供兼容处理。

## What it does / 功能

The plugin keeps Grok requests on the normal Responses HTTP/SSE path. It does not open or require a WebSocket connection.

插件让 Grok 请求继续使用标准 Responses HTTP/SSE，不打开也不依赖 WebSocket。

For every `input_image` in a Responses `message` or `function_call_output` item, the plugin reads image metadata with Sharp/libvips. If either image edge is 24 pixels or smaller, it:

对于 Responses `message` 或 `function_call_output` 中的每个 `input_image`，插件使用 Sharp/libvips 读取图片信息。如果图片任意一边不超过 24 像素，插件会：

1. Decode the original image with nearest-neighbor processing. / 使用最近邻方式解码原图。
2. Resize the actual pixels proportionally onto a 32x32 transparent canvas. / 按比例把真实像素放大到 32x32 透明画布中。
3. Add a text note containing the original dimensions and the resulting content dimensions. / 添加包含原图尺寸和实际内容尺寸的文字备注。

Square images fill the canvas. Narrow or rectangular images keep their aspect ratio and receive transparent padding instead of being stretched. Images whose width and height are both greater than 24 pixels are sent unchanged.

正方形图片会填满画布。窄图或矩形图保持原始比例，使用透明留白，不会被强行拉伸。宽度和高度都大于 24 像素的图片原样发送。

Sharp provides one mature decoding path for PNG, JPEG, GIF, WebP, TIFF, AVIF, and other supported formats. The plugin does not maintain separate handwritten image decoders.

Sharp 为 PNG、JPEG、GIF、WebP、TIFF、AVIF 以及其他支持的格式提供统一且成熟的解码路径。插件不再维护手写的格式专用解码器。

## Scope / 作用范围

Image normalization is enabled only when all of the following are true:

只有以下条件同时满足时才会进行图片规范化：

- Hostname / 主机名: `api.niumacode.cc`
- Endpoint / 接口: `/v1/responses`
- Model / 模型: starts with `grok-`

The route marker is `x-dsh-grok-adaptation: v2`. It identifies the configured NiuMa2 route, but the model-prefix check remains mandatory. Gemini, Qwen, GPT, web-search, and other non-Grok requests are forwarded unchanged, even if they carry the marker.

路由标记是 `x-dsh-grok-adaptation: v2`。它用于识别配置好的 NiuMa2 路由，但实际模型前缀检查仍然是必需条件。即使 Gemini、Qwen、GPT、web search 或其他非 Grok 请求带有该标记，也会原样转发，不会被修改。

## Install / 安装

Install the package into the DSH web profile:

将插件安装到 DSH web profile：

```powershell
dsh plugin --profile web add https://github.com/RailgunHamster/dsh-grok-adaptation.git
dsh plugin --profile web install
```

Restart `dsh-web` after installation. The package includes Sharp and its platform binary dependencies.

安装后重启 `dsh-web`。插件依赖中包含 Sharp 及其对应平台的二进制依赖。

## Route configuration / 路由配置

Add the marker only to the Grok route:

只给 Grok 路由添加标记：

```yaml
llm-pi-ai:
  providers:
    niumacode-2:
      api: openai-responses
      baseURL: https://api.niumacode.cc/v1
      apiKeyEnv: NIUMACODE2_API_KEY
      headers:
        x-dsh-grok-adaptation: v2
```

Do not add this marker to the normal GPT or web-search provider routes.

不要给普通 GPT 或 web-search provider 路由添加这个标记。

## Development / 开发

The package contains no credentials. It uses the `Authorization` header already created by DSH.

插件不包含任何凭据，使用 DSH 已经生成的 `Authorization` 请求头。

```powershell
pnpm install
pnpm run check
```

The tested cases include Grok 4.6 Responses requests with current-turn images and tool-result image replays, using PNG, JPEG, GIF, WebP, 1x16, 16x26, 16x32, and 16x16 inputs. Undersized images were normalized and the resulting requests completed successfully.

已测试 Grok 4.6 Responses 请求，包括当前轮图片和工具结果图片回放，覆盖 PNG、JPEG、GIF、WebP、1x16、16x26、16x32 和 16x16 图片。小图经过规范化后，请求成功完成。

## License / 许可证

MIT
