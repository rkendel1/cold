# Experimental HF SSH provider

This is a protocol experiment, not a working/verified Hugging Face integration. Production defaults remain unchanged.

## Enable locally without environment variables

1. Set `provider` to `"hf-ssh"` in `provider-config.json`. Restore `null` to return to the original provider selection.
2. Have OpenSSH available. Independently verify the service's host key through a trusted operator channel, then place its OpenSSH known-hosts entry in `hf-ssh-known-hosts` at the repository root. Do not blindly trust ssh-keyscan output. No API key is used; public-key/password authentication are explicitly disabled.
3. Run `npm start` and POST a fictional `{ "prompt": "Write a fictional cold email" }` to `http://127.0.0.1:3000/api/generate` with JSON content type.

The config endpoint intentionally reports `ready: false` for this experimental provider, so the ordinary UI will not advertise validated generation. Use the local endpoint directly for the experiment.

## Protocol hypothesis

The adapter requests a non-PTY session, sends one JSON prompt line to stdin, then closes input. It accepts only a clean JSON object with a nonempty `text` string on stdout. We have **no evidence** that chat.hf.co supports this protocol. Interactive TUI banners, escape sequences, prompt echoes, authentication requirements, or a persistent chat session will cause explicit errors, not fabricated output. No model selection command is invented: responses use `hf-ssh/unknown` rather than claiming Qwen.

A real session must establish input framing, session completion and model selection before this can be promoted. Service permission for automated use, quotas, availability and runtime support must also be confirmed. Anonymous access must actually be supported: the adapter does not bypass access controls. Do not send customer information while testing.

## Safety / limitations

Fixed destination, no shell interpolation, strict host verification, no client credentials, 30-second deadline, 64 KiB stdout cap and cancellation. Errors return 503; no automatic paid-provider fallback. It needs an SSH executable and outbound SSH from the actual host, neither verified for this project's production environment. The agent sandbox has no SSH executable and cannot perform external SSH tests. Unit tests mock the process and validate adapter behavior only; they do not establish live inference. Do not switch production based on these tests.
