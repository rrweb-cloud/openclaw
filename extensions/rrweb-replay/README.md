# `@rrwebcloud/openclaw-session-recording`

Portable rrweb replay plugin for OpenClaw-managed browsers.

## Install

```bash
openclaw plugins install @rrwebcloud/openclaw-session-recording
```

If you are working from this repository checkout instead of the published
package, use:

```bash
openclaw plugins install -l ./extensions/rrweb-replay
openclaw plugins install -l ./extensions/diagnostics-otel
```

## Minimal config

```yaml
plugins:
  entries:
    rrweb-replay:
      enabled: true
      publicKey: public_key_rr_your_public_key
```

## Notes

- OpenClaw `2026.3.24+` uses the automatic browser-runtime integration path
- OpenClaw `2026.3.13` loads in legacy compatibility mode and reports clear next steps instead of failing on install
- `serverUrl` defaults to `https://api.rrwebcloud.com`
- `publicKey` is required for rrwebcloud ingest
- `secretKey` is not required for recording; it is only needed if you want to query rrwebcloud APIs yourself
- OpenClaw now records rrweb events locally and uploads authenticated NDJSON from runtime code; it does not rely on browser-side `record.js` ingest
- the browser extension is optional for the runtime uploader path and is only needed when you specifically want extension-side behavior
- the plugin targets managed Chromium browser profiles such as `openclaw`
- `replay_session_info` exposes the active replay metadata
- When `diagnostics-otel` is enabled, replay-aware spans include `openclaw.replay.*` attributes. See [Logging](../../docs/logging.md).
