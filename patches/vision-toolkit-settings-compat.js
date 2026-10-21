/**
 * dsh >=0.1.7 compatibility shim: ctx.settings.register() was removed.
 * Keeps the old namespace semantics (get/update/watch + describe/replace with
 * revisions) on a local JSON store seeded from the migrated settings.yaml
 * section (see ~/.dsh/settings-compat/vision-toolkit.json).
 * @module dsh-vision-toolkit/settings-compat
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SettingsConflictError } from "@deepseek-ai/dsh-settings";
import { Config, VISION_TOOLKIT_SETTINGS_NAMESPACE } from "./config.js";

const STORE_PATH = join(homedir(), ".dsh", "settings-compat", "vision-toolkit.json");

const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const deepMerge = (target, patch) => {
    for (const [key, value] of Object.entries(patch ?? {})) {
        if (isPlainObject(value) && isPlainObject(target[key]))
            deepMerge(target[key], value);
        else
            target[key] = value;
    }
    return target;
};

const readStore = () => {
    try {
        return JSON.parse(readFileSync(STORE_PATH, "utf8"));
    }
    catch {
        return {};
    }
};

const writeStore = (value) => {
    try {
        mkdirSync(join(STORE_PATH, ".."), { recursive: true });
        writeFileSync(STORE_PATH, JSON.stringify(value, null, 2) + "\n");
    }
    catch { }
};

let active = null;

/** Build the compat handle: schema defaults <- entry base config <- JSON store. */
export function makeCompatSettings(base, validate) {
    let value = {};
    try {
        value = Config({});
    }
    catch { }
    value = deepMerge(value, structuredClone(base ?? {}));
    value = deepMerge(value, readStore());
    let revision = 0;
    const watchers = new Set();
    let inWatcher = false;
    const fire = async (previous) => {
        if (inWatcher)
            return;
        inWatcher = true;
        try {
            for (const watch of watchers)
                await watch(structuredClone(value), previous);
        }
        finally {
            inWatcher = false;
        }
    };
    const apply = async (nextValue, previous) => {
        value = nextValue;
        if (validate)
            validate(structuredClone(value));
        revision += 1;
        writeStore(value);
        await fire(previous);
    };
    const handle = {
        get: () => value,
        describe() {
            return {
                ns: VISION_TOOLKIT_SETTINGS_NAMESPACE,
                value: structuredClone(value),
                base: structuredClone(base ?? {}),
                revision,
                applies: "live",
            };
        },
        async update(patch) {
            const previous = structuredClone(value);
            await apply(deepMerge(structuredClone(value), patch ?? {}), previous);
        },
        async replace(section, expectedRevision) {
            if (expectedRevision !== undefined && expectedRevision !== revision) {
                throw new SettingsConflictError(VISION_TOOLKIT_SETTINGS_NAMESPACE, expectedRevision, revision);
            }
            const previous = structuredClone(value);
            await apply(deepMerge(structuredClone(value), section ?? {}), previous);
        },
        watch(callback) {
            watchers.add(callback);
            return () => { watchers.delete(callback); };
        },
    };
    active = handle;
    return handle;
}

/** The handle created by this activation's apply(), used by the Web backend. */
export function getActiveCompat() {
    return active;
}
