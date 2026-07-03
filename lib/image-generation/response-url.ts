export function normalizeBase64Payload(value: string): string {
  const normalized = (value || "").trim().replace(/[\r\n\s]/g, "");
  if (!normalized) return "";
  return normalized.replace(/-/g, "+").replace(/_/g, "/");
}

export function inferMimeTypeFromBase64Payload(value: string): string {
  const normalized = normalizeBase64Payload(value);
  if (!normalized) return "image/png";

  if (normalized.startsWith("iVBORw0KGgo")) return "image/png";
  if (normalized.startsWith("/9j/")) return "image/jpeg";
  if (normalized.startsWith("UklGR")) return "image/webp";
  if (normalized.startsWith("R0lGOD")) return "image/gif";
  if (normalized.startsWith("Qk")) return "image/bmp";
  if (
    normalized.startsWith("AAAAIGZ0eXBhdmlm") ||
    normalized.startsWith("AAAAGGZ0eXBhdmlm") ||
    normalized.startsWith("AAAAHmZ0eXBhdmlm")
  ) {
    return "image/avif";
  }
  if (normalized.startsWith("PHN2Zy") || normalized.startsWith("PD94bWwg")) {
    return "image/svg+xml";
  }

  return "image/png";
}

/**
 * 🔧 FIX (2026-05 #6 「破图缩略图」最后一道防线):
 * 判断 base64 头是否对应已知图像格式。inferMimeTypeFromBase64Payload 出于
 * 向后兼容会把任意未知数据兜底成 image/png —— 但若上游返回了 HTML 错误页 /
 * JSON / 损坏数据被错误透传到此处，浏览器会拿一份"标头说是 PNG 但解码失败"
 * 的 data URL，触发 onError → 破图。
 *
 * 此函数只接受真实图像 magic-byte（PNG/JPEG/WebP/GIF/BMP/AVIF/SVG）；不识别
 * 的 payload 一律视为非法，由上层切换到错误卡显示。
 */
export function hasKnownImageMagicHeader(value: string): boolean {
  const normalized = normalizeBase64Payload(value);
  if (!normalized) return false;
  if (normalized.startsWith("iVBORw0KGgo")) return true; // PNG
  if (normalized.startsWith("/9j/")) return true; // JPEG
  if (normalized.startsWith("UklGR")) return true; // WebP
  if (normalized.startsWith("R0lGOD")) return true; // GIF
  if (normalized.startsWith("Qk")) return true; // BMP
  if (
    normalized.startsWith("AAAAIGZ0eXBhdmlm") ||
    normalized.startsWith("AAAAGGZ0eXBhdmlm") ||
    normalized.startsWith("AAAAHmZ0eXBhdmlm")
  ) return true; // AVIF
  if (normalized.startsWith("PHN2Zy") || normalized.startsWith("PD94bWwg")) return true; // SVG
  return false;
}

export function normalizeImageResponseValueToUrl(value: string): string {
  const raw = (value || "").trim();
  if (!raw) return "";

  const markdownMatch = raw.match(/!\[[^\]]*]\(([^)]+)\)/i);
  const extracted = (markdownMatch?.[1] || raw)
    .trim()
    .replace(/^['"]|['"]$/g, "");

  if (!extracted) return "";
  if (/^data:image\//i.test(extracted)) {
    // 透传前再校验 base64 头是否真的是图片，挡住 "data:image/png;base64,<HTML>" 的误传
    const comma = extracted.indexOf(",");
    if (comma > 0) {
      const b64 = extracted.slice(comma + 1);
      if (!hasKnownImageMagicHeader(b64)) {
        if (typeof console !== "undefined") {
          console.warn(
            "[normalizeImageResponseValueToUrl] data URL magic-byte 校验失败 head=",
            b64.slice(0, 64)
          );
        }
        return "";
      }
    }
    return extracted;
  }
  if (/^https?:\/\//i.test(extracted)) return extracted;
  if (/^asset:\/\//i.test(extracted)) return extracted;
  if (/^blob:/i.test(extracted)) return extracted;

  const normalizedBase64 = normalizeBase64Payload(extracted);
  // 关键校验：拒绝任何 magic-byte 不匹配的 base64，避免下游 <img> 渲染破图。
  if (!hasKnownImageMagicHeader(normalizedBase64)) {
    if (typeof console !== "undefined") {
      console.warn(
        "[normalizeImageResponseValueToUrl] base64 magic-byte 校验失败 len=",
        normalizedBase64.length,
        "head=",
        normalizedBase64.slice(0, 64)
      );
    }
    return "";
  }
  const mimeType = inferMimeTypeFromBase64Payload(normalizedBase64);
  return `data:${mimeType};base64,${normalizedBase64}`;
}
