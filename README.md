# dsh-niuma-responses-ws

A small DeepSeek Harness bundle that routes selected NiuMa/Sub2API Responses requests through the Responses WebSocket v2 ingress.

This is useful for NiuMa Grok groups configured like the newer Codex CLI:

```toml
wire_api = "responses"
supports_websockets = true

[features]
responses_websockets_v2 = true
```

The plugin keeps the normal DSH `openai-responses` wire adapter. It marks only the route that should use WebSocket v2, then bridges the WebSocket event stream back to the SSE stream expected by `pi-ai`.

## Scope

A request is bridged only when all of these match:

- hostname: `api.niumacode.cc`
- path: `/v1/responses`
- header: `x-dsh-niuma-responses-ws: v2`

Unmarked requests are passed to the original `fetch` unchanged. This keeps the GPT route and the Niuma web-search backend on their existing HTTP/SSE path.

The bridge opens one WebSocket for each Responses request and sends the full DSH request body as `response.create`. It does not keep a connection-scoped `previous_response_id` cache; DSH's existing full-context replay remains the source of truth.

## Install in DSH

After publishing this repository, install it into the web profile using the current DSH plugin command:

```powershell
dsh plugin --profile web add https://github.com/<owner>/dsh-niuma-responses-ws
# Use the exact source URL shown by the current `dsh plugin --help` if the CLI requires an archive URL.
dsh plugin --profile web install
```

Restart `dsh-web` after installation and verify:

```powershell
dsh --profile web --dump-config | Select-String -Pattern 'niuma-responses-ws|websocketBeta|websocketBaseURL'
```

## Route configuration

Add the marker header only to the NiuMa2 route that should use the Sub2API WebSocket ingress:

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

The package has no bundled credentials. It uses the `Authorization` header already created by DSH's credential adapter.

```powershell
pnpm install
pnpm run check
```

The acceptance test used during development exercised `grok-4.6` with `reasoning=max`, `max_output_tokens=131072`, a tool call, tool-result replay, and a final answer through the WebSocket v2 bridge. No API key or session data is stored in this repository.

## License

MIT
