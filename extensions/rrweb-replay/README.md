# `@rrwebcloud/openclaw-session-recording`

Portable rrweb replay plugin for OpenClaw-managed browsers.

## Install

```bash
openclaw plugins install @rrwebcloud/openclaw-session-recording
```

## Minimal config

```yaml
plugins:
  entries:
    rrweb-replay:
      enabled: true
      publicKey: pk_live_your_public_key
      extensionMode: bundled
```

## Notes

- OpenClaw `2026.3.24+` uses the full automatic browser-runtime integration path
- OpenClaw `2026.3.13` loads in legacy compatibility mode and reports clear next steps instead of failing on install
- `serverUrl` defaults to `https://api.rrwebcloud.com`
- `secretKey` is not required for the bundled browser flow
- the plugin targets managed Chromium browser profiles such as `openclaw`
- `replay_session_info` exposes the active replay metadata
