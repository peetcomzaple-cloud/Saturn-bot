# Saturn bot

**Your AI team. Your models. Your workspace.**

An open-source workspace for AI teammates, with configurable model connections and a planet-inspired interface.

## Development status

This is a **development source snapshot** (commit f32fb041fa6b9a3f041c7993799ccca868d16e6c), not a stable/production release.

- Local Computer mode uses a Linux desktop container via a Docker-compatible engine installed by the user. It is **not** a Windows VM.
- Desktop unit tests recorded: 364 passed, 7 skipped, 0 failed — this does **not** certify native runtime or full integration.
- Not yet validated end-to-end on real user hardware for Docker/Compose/Electron. Saturn images are not published.
- Web production build checked in a separate checkout with Node 22.23.0; does not imply backend/model/live campaign pass.
- Avatar status fix applied (targeted authentication/locale/avatar tests 60/60 pass, shared UI typecheck, lint, web build). Independent source review done. Not a native/backend/campaign PASS.
- No comparative token/speed/cost claims vs competitors.

See [docs/VALIDATION_STATUS.md](docs/VALIDATION_STATUS.md) and [docs/LOCAL_COMPUTER.md](docs/LOCAL_COMPUTER.md).

Built on [Rakazo](https://github.com/elie222/rakazo). See [PROVENANCE.md](PROVENANCE.md), [NOTICE](NOTICE), and [LICENSE](LICENSE).
