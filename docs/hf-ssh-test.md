# Hugging Face SSH feasibility test

Run `npm run test:hf-ssh` from a local interactive terminal with an existing OpenSSH client. The actual command is `ssh chat.hf.co`, not `ssh https://chat.hf.co`. Normal SSH host-key checks remain enabled; verify any new fingerprint through a trusted source before accepting it.

This test opens a human-operated terminal session, not a supported API adapter. No existing Cold prompts, credentials, or customer information are sent. Use only the fictional prompt printed by the script.

Record these observations:

- Was anonymous access allowed without a key or account?
- Was `Qwen/Qwen3.8-27B` actually listed? Record the exact model; do not assume this identifier is correct.
- Did the response parse as JSON with string `subject` and `body` fields?
- Did a second fresh session work? Record latency and any errors or limit messages.
- Does the operator document permission for automated/commercial access, quotas, and a stable machine-readable protocol?

An exit code of zero means only the SSH process ended successfully. Neither that nor a successful response proves unlimited usage or production suitability. The probe times out after 120 seconds and requires manual observation.

## Current outcome

Live inference is **unverified**. The Vercel Agent sandbox has no `ssh` executable (`ssh -V` returned command not found), and arbitrary external SSH is outside its supported network access. Unit tests exercise the probe with a mocked process; they are not provider tests.

Cold still uses its original AI Gateway/Anthropic implementation. Do not remove existing authentication or switch production until the service supports automated access, its usage terms are confirmed, and generation is verified from the intended hosting environment. The existing AI Gateway credential selector already accepts `VERCEL_OIDC_TOKEN` as an alternative to a manually configured API key; that does not make inference unlimited or free.

Reference: https://huggingface.co/docs/chat-ui/index documents Hugging Face's OpenAI-compatible endpoint with an HF token. Reports of anonymous SSH chat do not establish an equivalent keyless HTTP API.
