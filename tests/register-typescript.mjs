import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Native Node strips TypeScript, but application imports use Next's extensionless
// resolution. Keep this bridge local to tests instead of changing app settings.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^\.{1,2}\//u.test(specifier) && context.parentURL?.startsWith("file:")) {
      const candidate = fileURLToPath(new URL(specifier, context.parentURL));
      if (!path.extname(candidate) && existsSync(`${candidate}.ts`)) {
        return nextResolve(pathToFileURL(`${candidate}.ts`).href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});
