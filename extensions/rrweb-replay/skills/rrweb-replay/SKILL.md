# rrweb Replay

Use this skill when you need session replay metadata for OpenClaw's managed browser.

What it does:

- Explains whether the `rrweb-replay` plugin is configured and active
- Shows the current replay session id via `replay_session_info`
- Helps activate replay context when `recordingPolicy` is `opt-in-tool`
- Points you to browser profile and extension troubleshooting

Operational notes:

- Runtime setup is handled by the native `rrweb-replay` plugin, not by this skill
- The core browser runtime can also expose replay through `browser.replay.*` when the rrwebcloud extension artifact is wired directly into managed browser startup
- The plugin targets OpenClaw-managed Chromium profiles such as `openclaw`
- The streamlined OpenClaw path only needs a public key; the bundled browser bootstrap defaults to the rrweb Cloud API endpoint and does not require a secret key
- Minimal config:

```yaml
plugins:
  entries:
    rrweb-replay:
      enabled: true
      publicKey: pk_live_your_public_key
      extensionMode: bundled
```

- If replay reports disabled, check:
  - `browser.replay.enabled`
  - `browser.replay.extensionPath`
  - `plugins.entries.rrweb-replay`
  - `rrweb-replay.extensionMode` / `rrweb-replay.extensionPath`
  - `rrweb-replay.publicKey` or `rrweb-replay.publicKeyEnvVar`
  - `browser.profiles.<name>.extensions` only if you are bypassing the plugin runtime seam

Useful command/tool flow:

- Run `replay_session_info` to inspect the current replay session
- Run `replay_session_info` with `activate=true` when replay is opt-in
- Use the reported `browserProfile` to verify which managed profile is being recorded

Troubleshooting:

- Missing extension directory: the bundled bootstrap extension was not staged; verify plugin install layout
- No replay session id: start a new OpenClaw session or use the browser tool so the plugin can bind session metadata
- Wrong profile: pass `profile` to `replay_session_info activate=true` or use the browser tool with an explicit `profile`
- Advanced setup: only override `rrweb-replay.serverUrl` if you are targeting a non-default replay API endpoint
