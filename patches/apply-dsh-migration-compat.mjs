#!/usr/bin/env node
/**
 * apply-dsh-migration-compat.mjs — 让 dsh 0.2.1-rc.2 能加载含遗留
 * `instruction-hint` 消息 source 的历史会话（v0/v2 格式，2026-09 以前的
 * anchored-tool-bootstrap 插件注入的 system-reminder 消息）。
 *
 * 症状：会话列表里部分旧会话加载失败，报
 *   failed to observe session "...": cannot safely transform unclassified
 *   message source; source v0 artifact remains unchanged
 * 原因：v2→v3 迁移的 SOURCE_KINDS 白名单没有收录 v2 时代合法的
 * `instruction-hint`；迁移器按设计拒绝继续（不改写原始文件）。
 *
 * 补丁（对 dsh 内两份打包副本各改两处，语义与上游对 `tools-code-mode` 的
 * renamePtcEvent 处理完全一致）：
 *   1. assertSource 放行 {kind:"instruction-hint", plugin:"<非空>"}；
 *   2. renameMessageSource 把它改写成 {kind:"plugin", plugin:"<原值>"}，
 *      v3→v4 随后产出 producer-owned 的 {kind:"plugin:<plugin>"}。
 *
 * 另有一批更早的 v0 会话（裸 UUID 命名，2026-09-01 的 subagent 子会话）卡在
 * subagent/descriptor version 2：
 *   failed to observe session "...": subagent/descriptor 0 uses unsupported
 *   descriptor version 2
 * v3 descriptor（continuable/one-shot）的字段是 v2 的超集，除版本号外完全
 * 同构，因此：
 *   3. assertReleasedEventPayload 把 v0 会话中的 version 2 descriptor 提升
 *      为 3 并落入常规 v3 严格校验（字段不合规仍会拒绝）。
 *
 * 需在每次 `npm install -g @deepseek-ai/dsh` 后重放（npm_update_dsh.sh
 * 已接入）。幂等：已打过的补丁跳过；锚点丢失（上游改版）则报错退出。
 */
import { readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";

function dshPackageDir() {
  const bin = execSync("command -v dsh", { encoding: "utf8", shell: "/bin/bash" }).trim();
  if (!bin) throw new Error("dsh binary not found on PATH");
  // <global>/bin/dsh -> ../lib/node_modules/@deepseek-ai/dsh/lib/bin.js
  let dir = dirname(realpathSync(bin));
  for (let i = 0; i < 4; i += 1) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (pkg.name === "@deepseek-ai/dsh") return dir;
    }
    dir = dirname(dir);
  }
  throw new Error(`cannot locate @deepseek-ai/dsh package dir from ${bin}`);
}

const dshDir = dshPackageDir();
let failed = false;

function patch(file, replacements) {
  if (!existsSync(file)) {
    console.error(`[migration-compat] MISSING ${file}`);
    failed = true;
    return;
  }
  let src = readFileSync(file, "utf8");
  for (const { name, marker, anchor, replacement } of replacements) {
    // 补丁正文与锚点开头相同，幂等检查用补丁特有标记串，不能用 replacement 前缀。
    if (src.includes(marker)) {
      console.log(`[migration-compat] ok (already applied): ${name}`);
      continue;
    }
    if (!src.includes(anchor)) {
      console.error(`[migration-compat] ANCHOR NOT FOUND for ${name} in ${file} — dsh upstream changed, review manually`);
      failed = true;
      continue;
    }
    src = src.replace(anchor, replacement);
    console.log(`[migration-compat] applied: ${name}`);
  }
  writeFileSync(file, src);
}

// ESM 模块副本（主线程路径使用）
const esmIndex = join(dshDir, "node_modules", "@deepseek-ai", "dsh-session-format-v2-to-v3", "lib", "index.js");
// persistence worker 打包副本（实际执行会话迁移的进程）
const workerCjs = join(dshDir, "node_modules", "@deepseek-ai", "dsh-session-persistence-jsonl", "lib", "worker.cjs");
// v0→v1 转换器（ESM 与 worker 各一份）
const esmV0ToV1 = join(dshDir, "node_modules", "@deepseek-ai", "dsh-session-format-v0-to-v1", "lib", "index.js");

const assertSourcePatch = (recordRef) => ({
  name: "v2-to-v3 assertSource: admit legacy instruction-hint",
  marker: `if (source["kind"] === "instruction-hint" && typeof source["plugin"] === "string" && source["plugin"].length > 0) return;`,
  name: "v2-to-v3 assertSource: admit legacy instruction-hint",
  anchor: `function assertSource(message) {
\tconst source = ${recordRef}(message["source"], "message source");
\tif (typeof source["kind"] !== "string" || !SOURCE_KINDS.has(source["kind"])) throw new SessionFormatUnsupportedMigrationError("cannot safely transform unclassified message source");`,
  replacement: `function assertSource(message) {
\tconst source = ${recordRef}(message["source"], "message source");
\tif (source["kind"] === "instruction-hint" && typeof source["plugin"] === "string" && source["plugin"].length > 0) return;
\tif (typeof source["kind"] !== "string" || !SOURCE_KINDS.has(source["kind"])) throw new SessionFormatUnsupportedMigrationError("cannot safely transform unclassified message source");`,
});

const renamePatch = {
  name: "v2-to-v3 renameMessageSource: instruction-hint -> plugin",
  marker: `if (source["kind"] === "instruction-hint") {`,
  anchor: `function renameMessageSource(message) {
\tconst source = message["source"];
\tif (source["kind"] !== "plugin" || source["plugin"] !== "tools-code-mode") return message;`,
  replacement: `function renameMessageSource(message) {
\tconst source = message["source"];
\tif (source["kind"] === "instruction-hint") {
\t\tif (typeof source["plugin"] !== "string" || source["plugin"].length === 0) return message;
\t\treturn {
\t\t\t...message,
\t\t\tsource: {
\t\t\t\t...source,
\t\t\t\tkind: "plugin"
\t\t\t}
\t\t};
\t}
\tif (source["kind"] !== "plugin" || source["plugin"] !== "tools-code-mode") return message;`,
};

// v0 会话中的 subagent/descriptor version 2 → 提升为 3 并落入常规 v3 校验。
// v3 continuable/one-shot 的字段集是 v2 的超集，除版本号外同构。
const descriptorPatch = {
  name: "v0-to-v1 subagent descriptor: promote legacy version 2",
  marker: `if (descriptorVersion !== 2) throw new SessionFormatUnsupportedMigrationError`,
  anchor: `\tif (event.type === "subagent/descriptor" && data["version"] !== 3) {
\t\tconst descriptorVersion = sessionFormatCount(data["version"], \`\${event.type} \${event.seq} version\`);
\t\tif (version === 0) throw new SessionFormatUnsupportedMigrationError(\`\${event.type} \${event.seq} uses unsupported descriptor version \${descriptorVersion}\`);
\t\treturn;
\t}`,
  replacement: `\tif (event.type === "subagent/descriptor" && data["version"] !== 3) {
\t\tconst descriptorVersion = sessionFormatCount(data["version"], \`\${event.type} \${event.seq} version\`);
\t\tif (version === 0) {
\t\t\tif (descriptorVersion !== 2) throw new SessionFormatUnsupportedMigrationError(\`\${event.type} \${event.seq} uses unsupported descriptor version \${descriptorVersion}\`);
\t\t\tdata["version"] = 3;
\t\t} else return;
\t}`,
};

patch(esmIndex, [assertSourcePatch("record"), renamePatch]);
patch(workerCjs, [assertSourcePatch("record$2"), renamePatch]);
patch(esmV0ToV1, [descriptorPatch]);
patch(workerCjs, [descriptorPatch]);

if (failed) {
  console.error("[migration-compat] FAILED — see messages above");
  process.exit(1);
}
console.log("[migration-compat] all patches applied; restart dsh-codeserver-proxy");
