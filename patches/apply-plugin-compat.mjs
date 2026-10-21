#!/usr/bin/env node
/**
 * apply-plugin-compat.mjs — re-apply dsh 0.1.7 compatibility patches to two
 * community plugins that still call the removed ctx.settings.register() API
 * (and, for dsh-at-file, the removed schemastery strict typert codecs).
 *
 * Patches are needed after every `npm update` of dsh that re-syncs the
 * ~/.dsh/profiles/web workspace. Idempotent: skips any patch already present.
 * Exits non-zero if an anchor is missing (upstream changed) — re-review then.
 *
 * Values persist in ~/.dsh/settings-compat/*.json (seeded once from the
 * migrated ~/.dsh/settings.yaml.imported sections).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const profileWeb = join(homedir(), ".dsh", "profiles", "web");
let failed = false;

function patch(file, replacements) {
  if (!existsSync(file)) {
    console.error(`[compat] MISSING ${file}`);
    failed = true;
    return;
  }
  let src = readFileSync(file, "utf8");
  for (const { name, anchor, replacement } of replacements) {
    if (src.includes(replacement.slice(0, 80))) {
      console.log(`[compat] ok (already applied): ${name}`);
      continue;
    }
    if (!src.includes(anchor)) {
      console.error(`[compat] ANCHOR NOT FOUND for ${name} in ${file} — upstream changed, review manually`);
      failed = true;
      continue;
    }
    src = src.replace(anchor, replacement);
    console.log(`[compat] applied: ${name}`);
  }
  writeFileSync(file, src);
}

// --- dsh-at-file: settings.register -> local JSON store --------------------
const atFile = join(profileWeb, "node_modules/dsh-at-file/lib/index.js");
patch(atFile, [
  {
    name: "at-file: compat imports",
    anchor: 'var __create = Object.create;',
    replacement: 'import { readFileSync as __compatReadFile, writeFileSync as __compatWriteFile, mkdirSync as __compatMkdir } from "node:fs";\nimport { homedir as __compatHomedir } from "node:os";\nimport { join as __compatJoin } from "node:path";\nvar __create = Object.create;',
  },
  {
    name: "at-file: registerAtFileSettings shim",
    anchor: `function registerAtFileSettings(ctx) {
  return ctx.settings.register(AT_FILE_NAMESPACE, AtFileSettingsSchema, { applies: "live" });
}`,
    replacement: `// dsh >=0.1.7 removed ctx.settings.register; keep the old namespace semantics
// on a local JSON store seeded from the migrated settings.yaml section.
var AT_FILE_COMPAT_PATH = (() => {
  try {
    return __compatJoin(__compatHomedir(), ".dsh", "settings-compat", "at-file.json");
  } catch {
    return "";
  }
})();
function atFileCompatLoad() {
  let value = {};
  try {
    value = AtFileSettingsSchema({});
  } catch {
  }
  try {
    const persisted = JSON.parse(__compatReadFile(AT_FILE_COMPAT_PATH, "utf8"));
    value = { ...value, ...persisted };
  } catch {
  }
  return value;
}
function registerAtFileSettings(ctx) {
  let value = atFileCompatLoad();
  return {
    get: () => value,
    async update(patch) {
      value = { ...value, ...patch };
      try {
        __compatMkdir(__compatJoin(AT_FILE_COMPAT_PATH, ".."), { recursive: true });
        __compatWriteFile(AT_FILE_COMPAT_PATH, JSON.stringify(value, null, 2) + "\\n");
      } catch {
      }
    },
    watch(_cb) {
      return () => {
      };
    }
  };
}`,
  },
  {
    name: "at-file: search codec -> src-json",
    anchor: `codec: { mode: "strict", typeSymbol: "@deepseek-ai/dsh-session/types#SessionId", schema: sessionIdSchema }
      }
    ],
    cancellation: { parameter: "signal" },
    result: {
      mode: "strict",
      typeSymbol: "dsh-at-file#FileEntry[]",
      schema: external_exports.array(fileEntrySchema)
    }`,
    replacement: `codec: { mode: "src-json" }
      }
    ],
    cancellation: { parameter: "signal" },
    result: { mode: "src-json" }`,
  },
  {
    name: "at-file: getSettings result -> src-json",
    anchor: `    parameters: [],
    result: {
      mode: "strict",
      typeSymbol: "dsh-at-file#AtFileSettings",
      schema: atFileSettingsSchema
    }`,
    replacement: `    parameters: [],
    result: { mode: "src-json" }`,
  },
  {
    name: "at-file: updateSettings codec -> src-json",
    anchor: `        codec: {
          mode: "strict",
          typeSymbol: "dsh-at-file#AtFileSettingsUpdate",
          schema: atFileSettingsUpdateSchema
        }
      }
    ],
    result: {
      mode: "strict",
      typeSymbol: "dsh-at-file#AtFileSettings",
      schema: atFileSettingsSchema
    }`,
    replacement: `        codec: { mode: "src-json" }
      }
    ],
    result: { mode: "src-json" }`,
  },
]);

// --- @anionex/dsh-vision-toolkit: settings.register -> shared compat module -
// 0.1.47+ ships its own native compatibility layer (bindVisionSettings from
// its own settings-compat.js). Patching that build would layer imports of
// exports that no longer exist (makeCompatSettings/getActiveCompat) and crash
// the plugin at ESM link time — so when the native layer is detected, the
// whole section is skipped. Only pre-0.1.47 builds (ctx.settings.register)
// need our compat shim.
const vtDir = join(profileWeb, "node_modules", "@anionex/dsh-vision-toolkit/lib");
const vtIndex = join(vtDir, "index.js");
const vtCompat = join(vtDir, "settings-compat.js");
const vtNativeCompat = existsSync(vtIndex) && readFileSync(vtIndex, "utf8").includes("bindVisionSettings");

if (vtNativeCompat) {
  console.log("[compat] vision-toolkit: native settings compat detected (>=0.1.47); no patch needed");
} else if (existsSync(vtIndex) && !existsSync(vtCompat)) {
  writeFileSync(vtCompat, readFileSync(new URL("./vision-toolkit-settings-compat.js", import.meta.url), "utf8"));
  console.log("[compat] applied: vision-toolkit settings-compat.js");
} else if (existsSync(vtCompat)) {
  console.log("[compat] ok (already applied): vision-toolkit settings-compat.js");
} else {
  console.error(`[compat] MISSING ${vtIndex}`);
  failed = true;
}

if (!vtNativeCompat) patch(join(vtDir, "index.js"), [
  {
    name: "vt: index wiring",
    anchor: `import { MAX_PASTE_IMAGE_BYTES, PastedImageBackend } from "./paste-images.js";`,
    replacement: `import { MAX_PASTE_IMAGE_BYTES, PastedImageBackend } from "./paste-images.js";
import { makeCompatSettings } from "./settings-compat.js";`,
  },
  {
    name: "vt: apply() register -> compat",
    anchor: `    const settings = ctx.settings.register(VISION_TOOLKIT_SETTINGS_NAMESPACE, Config, {
        base: config,
        applies: 'live',
        validate: (value) => { resolveConfig(value); },
    });`,
    replacement: `    const settings = makeCompatSettings(config, (value) => { resolveConfig(value); });`,
  },
]);

if (!vtNativeCompat) patch(join(vtDir, "web.js"), [
  {
    name: "vt: web.js import",
    anchor: `import { sameOriginPost, sameOriginRequest } from "./web-request.js";`,
    replacement: `import { sameOriginPost, sameOriginRequest } from "./web-request.js";
import { getActiveCompat } from "./settings-compat.js";`,
  },
  {
    name: "vt: descriptorOf -> compat",
    anchor: `function descriptorOf(ctx) {
    const descriptor = ctx.settings.describe().find(row => row.ns === VISION_TOOLKIT_SETTINGS_NAMESPACE);
    if (descriptor === undefined)
        throw new Error('vision-toolkit Settings namespace is not registered');
    return descriptor;
}`,
    replacement: `function descriptorOf(ctx) {
    const compat = getActiveCompat();
    if (compat === undefined)
        throw new Error('vision-toolkit Settings namespace is not registered');
    return compat.describe();
}`,
  },
  {
    name: "vt: snapshot writable",
    anchor: `            writable: this.ctx.settings.writable,`,
    replacement: `            writable: true,`,
  },
  {
    name: "vt: save writable check",
    anchor: `        if (!this.ctx.settings.writable)
            throw new Error('settings provider is read-only');
        const current = resolveConfig(descriptorOf(this.ctx).value);`,
    replacement: `        const current = resolveConfig(descriptorOf(this.ctx).value);`,
  },
  {
    name: "vt: replace -> compat",
    anchor: `        await this.ctx.settings.replace(VISION_TOOLKIT_SETTINGS_NAMESPACE, value, request.expectedRevision);`,
    replacement: `        await getActiveCompat().replace(value, request.expectedRevision);`,
  },
]);

if (failed) {
  console.error("[compat] FAILED — see messages above");
  process.exit(1);
}
console.log("[compat] all patches applied; restart dsh-codeserver-proxy");
