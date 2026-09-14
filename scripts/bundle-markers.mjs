/**
 * 产物文本匹配工具（build.mjs 与 verify-package.mjs 共用）。
 *
 * 为什么需要"解转义后再匹配"：
 *   esbuild 默认会把非 ASCII 字符（例如中文）写成 `\uXXXX` 转义序列。
 *   于是"源码里明明写着「钉钉文档」"和"产物里能搜到「钉钉文档」"是两回事——
 *   直接 `includes('钉钉文档')` 会漏掉一个**完全正确**的产物，
 *   把"构建对了"误判成"契约漂移"。这类假失败会引导人去改本来正确的代码。
 *
 * 本模块只做**只读还原**：把源码文本里的转义序列解释回真实字符，用于匹配判断，
 * 绝不回写到产物。
 */

/**
 * 把 JS 文本里的 `\uXXXX` / `\u{XXXXX}` / `\xXX` 转义还原成真实字符。
 * @param {string} source
 * @returns {string}
 */
export function decodeEscapes(source) {
  return String(source)
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}/gu, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/gu, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/gu, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
}

/**
 * 标记是否存在于产物中（原样或解转义后）。
 * @param {string} source - 产物全文。
 * @param {string} needle - 要找的字符串。
 * @returns {boolean}
 */
export function containsMarker(source, needle) {
  if (typeof source !== 'string' || typeof needle !== 'string' || needle === '') return false
  return source.includes(needle) || decodeEscapes(source).includes(needle)
}

/**
 * 返回缺失的标记列表（附带是"原样命中"还是"解转义命中"，便于诊断）。
 * @param {string} source
 * @param {readonly {label: string, needle: string}[]} markers
 * @returns {{missing: {label: string, needle: string}[], escapedOnly: string[]}}
 */
export function auditMarkers(source, markers) {
  const missing = []
  const escapedOnly = []
  for (const marker of markers) {
    if (source.includes(marker.needle)) continue
    if (containsMarker(source, marker.needle)) {
      escapedOnly.push(marker.label)
      continue
    }
    missing.push(marker)
  }
  return { missing, escapedOnly }
}
