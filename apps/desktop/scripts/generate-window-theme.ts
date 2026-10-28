import { writeFile } from "node:fs/promises";
import { darkTokens } from "../../../packages/ui-tokens/src/index.js";

// Desktop ships compiled JS without the source-only ui-tokens package.
// Snapshot the shared token at build time instead of maintaining a second palette.
await writeFile(
  new URL("../src/window-theme.generated.ts", import.meta.url),
  `// Generated from @rakazo/ui-tokens; do not edit manually.\nexport const windowBackground = ${JSON.stringify(darkTokens.background)};\n`,
);
