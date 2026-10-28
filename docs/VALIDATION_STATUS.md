# Validation and release boundaries

This repository is a development source snapshot. Source verification and a successful build do not establish whole-product or live-provider acceptance.

## Checked in the isolated Saturn repository

- Web production build completed successfully.
- Web and shared UI TypeScript checks completed successfully.
- Desktop TypeScript build and static-asset copying completed successfully; Electron was not launched.
- Three affected web authentication/locale test files passed: 22 tests. These use mocks/emulators, not live providers.
- The component visual fixture typechecks after removing an obsolete component reference and completing its mocked data contract.
- Selected foreground, button, muted-text and link color pairs were checked mathematically in light/dark palettes. This is not a full accessibility audit.
- A later focused check found that planet avatars lacked the shared working-status indicator. After restoring that indicator, four affected authentication, locale and avatar test files passed all 60 tests, including active/idle coverage for all 12 planets. Shared web UI typechecking and the web production build also passed. This is not a full-suite or live-backend result.

These later checks used the existing Node.js 22.23.0 runtime. Use a Node version supported by the locked development dependencies; Node.js 22.14.0 does not meet the locked jsdom requirement.

## Later Local Computer checks

- Docker commands now return before spawning when already cancelled. The focused regression and affected command-control checks passed in the earlier isolated follow-up.
- Docker output now preserves UTF-8 characters split across pipe chunks. Both new Thai/emoji regressions failed before the change and passed afterward; the existing pre-cancelled-command regression also passed. Desktop theme generation, direct TypeScript checking and focused lint passed.
- Two real-child-process output tests still fail in the current executor on both the unchanged baseline and the UTF-8 change. Their cause remains unresolved. Mocked pipe tests and typechecking do not establish native runtime or full-suite acceptance.

- A subsequent Local Computer integration check found that the supervisor ignored the computer image already selected by Compose. It now consumes that existing setting, refuses to build a replacement for an unavailable explicit image, and preserves the actual image when resuming a computer. The regression failed before the change; 11 focused mocked image/lifecycle checks and 31 affected fixture checks passed afterward. Supervisor TypeScript checking passed after correcting three test fixture types. Actual image startup remains unverified.

- A desktop regression run now finishes after fixing an OAuth test fixture that waited forever when socket reservation failed. That run reported 346 passed, 21 failed and 7 skipped. A later fixture-only separation lets seven prevalidation/cancellation/device-code cases run without reserving a port; all seven passed with explicit expected errors. Ten real callback/listener cases still fail on denied loopback binding. The two child-output failures, one native child-spawn failure and one local-port failure remain; none is converted to a product PASS. The complete suite has not been rerun after that final fixture-only separation.

## Still unverified or unavailable

- Actual screenshots/interaction review of the new navy/gold theme: the attempted isolated loopback preview could not listen in the current execution environment. Earlier prototype screenshots are not certification of this theme.
- A newly configured, authenticated backend/API/worker installation and live model/tool execution.
- Native iOS/Android runtime, store registration/signing, Electron runtime and installer/update operation.
- The Local Computer feature includes a placeholder-only Compose environment template. Actual installer packaging, signatures and installed stack startup remain unverified; runtime `.env` files are not included. A compile result is not an installer-package result.
- Native app identifiers are prospective development identifiers. Foreign Expo owner/project/update bindings were removed; Expo OTA remains disabled until an authorized release configuration exists. Desktop update configuration names only the intended Saturn repository; it does not prove a release exists.
- Legacy internal `@rakazo` packages, RPC/storage/deep-link names are retained for compatibility. Review native side-by-side installation and authentication callbacks before release; this branding change does not certify an identity migration.
- No comparative token, speed, quality, reliability or cost benchmark against other products has been run.

No production deployment, merge or release is implied. Original campaign evidence stays bound to its original source/build and acceptance scope.

## Optional release workflow checks

The seven inherited desktop release-workflow checks are explicitly skipped when the release/signing workflow is absent from this source distribution. Their requirements remain for a future real pipeline and now refer to the intended Saturn feed. This is not a release PASS, and the full project test suite is not claimed passed.
