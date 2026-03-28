# rrweb Replay

Use this skill when you need session replay metadata for OpenClaw's managed browser.

What it does:

- Explains whether the `rrweb-replay` plugin is configured and active
- Shows the current replay session id via `replay_session_info`
- Helps activate replay context when `recordingPolicy` is `opt-in-tool`
- Points you to browser profile and rrwebcloud upload troubleshooting

Operational notes:

- Runtime setup is handled by the native `rrweb-replay` plugin, not by this skill
- The core browser runtime can also expose replay through `browser.replay.*` when the rrwebcloud extension artifact is wired directly into managed browser startup
- The plugin targets OpenClaw-managed Chromium profiles such as `openclaw`
- The streamlined OpenClaw path records rrweb events in the managed browser and uploads authenticated NDJSON from runtime code
- The streamlined OpenClaw path only needs a public key; the rrweb Cloud API endpoint defaults to `https://api.rrwebcloud.com` and recording does not require a secret key
- Minimal config:

```yaml
plugins:
  entries:
    rrweb-replay:
      enabled: true
      publicKey: public_key_rr_your_public_key
```

- If replay reports disabled, check:
  - `plugins.entries.rrweb-replay`
  - `rrweb-replay.publicKey` or `rrweb-replay.publicKeyEnvVar`
  - `rrweb-replay.serverUrl` only if you intentionally override the default API host
  - `browser.profiles.<name>.driver` is a managed profile such as `openclaw`
  - `browser.profiles.<name>.extensions` only if you are intentionally layering extension-side behavior on top of runtime upload

Useful command/tool flow:

- Run `replay_session_info` to inspect the current replay session
- Run `replay_session_info` with `activate=true` when replay is opt-in
- Use the reported `browserProfile` to verify which managed profile is being recorded

Troubleshooting:

- Missing extension directory: runtime upload can still work; only extension-side behavior is unavailable
- No replay session id: start a new OpenClaw session or use the browser tool so the plugin can bind session metadata
- Wrong profile: pass `profile` to `replay_session_info activate=true` or use the browser tool with an explicit `profile`
- Advanced setup: only override `rrweb-replay.serverUrl` if you are targeting a non-default replay API endpoint
