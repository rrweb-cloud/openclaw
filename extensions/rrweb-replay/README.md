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

- `serverUrl` defaults to `https://api.rrwebcloud.com`
- `secretKey` is not required for the bundled browser flow
- the plugin targets managed Chromium browser profiles such as `openclaw`
- `replay_session_info` exposes the active replay metadata
