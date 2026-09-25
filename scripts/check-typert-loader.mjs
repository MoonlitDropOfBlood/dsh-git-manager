// 一次性诊断：用真实 dsh-typert-loader 的 validateTypertManifest 校验本包 TYPERT。
// 用法：node scripts/check-typert-loader.mjs <typert-loader/lib/index.js 绝对路径>
import { pathToFileURL } from "node:url";
import { TYPERT } from "../typert.host.js";

const target = process.argv[2];
if (!target) {
  console.error("usage: node scripts/check-typert-loader.mjs <path-to-dsh-typert-loader-lib-index.js>");
  process.exit(2);
}
const { validateTypertManifest } = await import(pathToFileURL(target).href);
try {
  validateTypertManifest("@duke-dsh-plugins/dsh-git-manager", TYPERT);
  console.log("PASS: validateTypertManifest accepted TYPERT");
} catch (e) {
  console.log("FAIL: " + e.message);
  process.exit(1);
}
