# Saturn desktop icons

The licensed Saturn logo is copied unchanged to `saturn-logo.png`. Desktop build metadata selects that PNG for Windows/Linux and the shared `packages/ui-tokens/assets/Saturn.icon` bundle for macOS. Electron-builder can convert source icons during packaging.

Other inherited icon files remain as source assets and are not selected as the current application icon. Platform packaging/signing and actual icon rendering have not been verified here; the successful desktop build is TypeScript compilation plus static-asset copying only.
