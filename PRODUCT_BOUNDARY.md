# Product and runtime boundary

The extracted application uses its own vendored packages/contracts, packages/core and other workspace packages. apps/web uses the typed oRPC client in src/lib/rpc.ts and its same-origin /rpc interface; apps/api/src/app.ts handles /rpc. Threads subscription remains the existing streaming contract. Auth/session, attachments, cancellation, bot settings and artifacts continue to require real backend implementations. No template t.reply/timeouts are introduced as AI behavior.

The extracted web source still includes upstream API_PROXY_TARGET fallback to loopback port 3100. DO NOT start it with defaults: a future separately reviewed preview must specify its own isolated backend/ports, DB/schema/storage/browser profiles and external-provider permissions. No connection to the campaign or shared environment is authorized by copying files. A disconnected visual preview must say that backend interaction is unavailable.

API/shared-core strategy: vendor the matching backend and shared packages at the recorded source commit, then evolve them in this repository. No symlinks, Git worktree dependency or runtime import into the campaign checkout are intended. A frontend-only extraction would lose required shared contracts/backend functions and is not the chosen initial boundary.

Dependency installation, the isolated web build, selected UI typechecks/tests and desktop compilation have completed; see docs/VALIDATION_STATUS.md for their scope. Still unverified: environment templates and isolated runtime configuration, authenticated real backend interactions, native runtime parity and release/update/image destinations. Existing image registry references require review before installer/release operation. No service was started successfully here.

Excluded: original .git/history/remote, campaign outputs and acceptance evidence, root audit reports, failures/results, recovery work trees, .env files and runtime credentials/data, original marketing site, CI workflows and deployment automation, dependencies/build outputs. Relevant upstream instructions and legal notices remain.

Current validation is recorded in docs/VALIDATION_STATUS.md. The independent web build and selected UI checks now pass; backend/live/native acceptance remains unverified. No service from this copy was started successfully.
