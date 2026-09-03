# dsh-niuma-responses-ws

A DeepSeek Harness bundle that keeps NiuMa/Sub2API Grok requests on the normal OpenAI Responses HTTP/SSE path and normalizes undersized image inputs before they reach the upstream.

The package name is retained for compatibility with the existing DSH profile installation. It no longer opens a WebSocket connection.

## Behavior

The plugin targets:

- hostname: `api.niumacode.cc`
- path: `/v1/responses`
- preferred route marker: `x-dsh-niuma-responses-ws: v2`
- compatibility fallback: a request model starting with `grok-`

For each `input_image` in a Responses `message` or `function_call_output` item, it asks Sharp/libvips for image metadata. Images with either edge at or below 24px are decoded and rendered onto a 32x32 transparent canvas with nearest-neighbor sampling. The original dimensions and the resulting content dimensions are added as an adjacent text part. This preserves tiny texture pixels while satisfying the upstream image-size boundary without distorting narrow images.

Images with both edges above 24px are sent unchanged. PNG, JPEG, GIF, WebP, TIFF, AVIF, and other formats supported by Sharp are handled through the same code path. If Sharp cannot decode an undersized image, the request remains valid and receives a dimensioned text note instead of an invalid image block.

Non-Grok requests, including the normal NiuMa GPT and web-search routes, are passed through unchanged. The wrapper also reconstructs the body when it has inspected a request stream, so non-target requests are not sent with an already-consumed body.

## Install in DSH

After publishing this repository, install it into the web profile using the current DSH plugin command:

```powershell
dsh plugin --profile web add https://github.com/<owner>/dsh-niuma-responses-ws
# Use the exact source URL shown by the current `dsh plugin --help` if the CLI requires an archive URL.
dsh plugin --profile web install
```

Restart `dsh-web` after installation and verify:

```powershell
dsh --profile web --dump-config | Select-String -Pattern 'niuma-responses-ws|autoModelPrefixes|sharp'
```

## Route configuration

Add the marker header only to the NiuMa2 route that should receive the Grok image compatibility handling:

```yaml
llm-pi-ai:
  providers:
    niumacode-2:
      api: openai-responses
      baseURL: https://api.niumacode.cc/v1
      apiKeyEnv: NIUMACODE2_API_KEY
      headers:
        x-dsh-niuma-responses-ws: v2
```

Do not add this header to the normal GPT route or the web-search provider route.

## Development

The package has no bundled credentials. It uses the `Authorization` header already created by DSH's credential adapter. Sharp is the only image-processing dependency and ships platform binaries through its normal package distribution.

```powershell
pnpm install
pnpm run check
```

The acceptance tests exercised `grok-4.6` through Responses HTTP with current-turn and tool-result image inputs, including PNG, JPEG, GIF, WebP, 1x16, 16x26, 16x32, and 16x16 cases. Undersized inputs were normalized to a 32x32 canvas and the resulting requests completed successfully. No API key or session data is stored in this repository.

## License

MIT
