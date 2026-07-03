/**
 * Text chunker for TTS - splits long text into manageable chunks
 * and provides WAV audio concatenation utilities.
 */

const SENTENCE_TERMINATORS = /([。！？!?.;\n])/;

/**
 * Phase A（VIDEO_PIPELINE_REDESIGN_PLAN §5.1 L2）：数字上下文守卫。
 * 英文句点夹在数字之间（"3.14"、"v2.5"）或作为行内序号（"1. 标题"）时
 * 不是句子边界——在这里切分会让 TTS 读出断裂语调。
 */
function isSafeSentenceBoundary(window: string, index: number): boolean {
  const char = window[index];
  if (char !== ".") return true;
  const prev = window[index - 1] || "";
  const next = window[index + 1] || "";
  // 小数 / 版本号 / 编号："3.14"、"v2.5"、"10.0.26200"
  if (/\d/.test(prev) && /\d/.test(next)) return false;
  // 序号点后紧跟空格+内容（"1. 标题"）：点本身不是句末
  if (/\d/.test(prev) && next === " ") return false;
  // 英文缩写（"e.g."、"U.S."）：点前后都是字母
  if (/[A-Za-z]/.test(prev) && /[A-Za-z]/.test(next)) return false;
  return true;
}

/**
 * Split text into chunks of at most maxChars,
 * preferring to split at sentence boundaries.
 */
export function chunkText(text: string, maxChars = 500): string[] {
  if (!text || text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      chunks.push(remaining);
      break;
    }

    // Try to find a sentence boundary within maxChars
    const window = remaining.slice(0, maxChars);
    let splitIdx = -1;

    // Search backwards for a sentence terminator
    for (let i = window.length - 1; i >= Math.floor(maxChars * 0.3); i--) {
      if (SENTENCE_TERMINATORS.test(window[i]) && isSafeSentenceBoundary(window, i)) {
        splitIdx = i + 1;
        break;
      }
    }

    // If no sentence boundary found, split at maxChars
    if (splitIdx <= 0) {
      // Try comma or space
      for (let i = window.length - 1; i >= Math.floor(maxChars * 0.5); i--) {
        if (window[i] === "，" || window[i] === "," || window[i] === " ") {
          splitIdx = i + 1;
          break;
        }
      }
    }

    if (splitIdx <= 0) {
      splitIdx = maxChars;
    }

    chunks.push(remaining.slice(0, splitIdx).trim());
    remaining = remaining.slice(splitIdx).trim();
  }

  return chunks.filter((c) => c.length > 0);
}

/**
 * Concatenate multiple WAV base64 chunks into a single WAV.
 * Strips WAV headers from subsequent chunks, merges PCM data,
 * and writes a new combined WAV header.
 */
export function concatenateWavBase64(wavBase64Chunks: string[]): string {
  if (wavBase64Chunks.length === 0) return "";
  if (wavBase64Chunks.length === 1) return wavBase64Chunks[0];

  const buffers = wavBase64Chunks.map(base64ToBytes);

  // Parse header from first WAV
  const firstBuf = buffers[0];
  if (firstBuf.length < 44) {
    throw new Error("First WAV chunk is too small to contain a valid header");
  }
  // 🔧 FIX (2026-06-11 BUG-B4): 非 WAV 输入（如 MP3）按 WAV 砍头拼接只会产出垃圾，
  // 这里先校验首块 RIFF magic，直接抛错让上游分流。单块直通分支不受影响（保持旧行为）。
  if (!hasRiffMagic(firstBuf)) {
    throw new Error("concatenateWavBase64: 输入不是 WAV (缺少 RIFF 头)");
  }

  // 🔧 FIX (2026-06-11 BUG-BS5): 不再假设 44 字节固定头——按 RIFF chunk 遍历定位
  // "fmt " 与 "data" 的真实偏移读取声道数/采样率/位深与 PCM 起点，兼容带 LIST/INFO
  // 等附加 chunk 的非标准 WAV；遍历失败时回退旧的固定偏移读取，保持向后兼容。
  const firstLayout = parseWavLayout(firstBuf);
  const view = new DataView(
    firstBuf.buffer,
    firstBuf.byteOffset,
    firstBuf.byteLength
  );
  const numChannels = firstLayout?.numChannels ?? view.getUint16(22, true);
  const sampleRate = firstLayout?.sampleRate ?? view.getUint32(24, true);
  const bitsPerSample = firstLayout?.bitsPerSample ?? view.getUint16(34, true);

  // Find data chunk offset in first file
  const dataOffset = firstLayout?.dataOffset ?? findDataChunkOffset(firstBuf);

  // Collect PCM data from all chunks
  const pcmChunks: Uint8Array[] = [];
  let totalPcmBytes = 0;

  for (let i = 0; i < buffers.length; i++) {
    const buf = buffers[i];
    // 🔧 FIX (2026-06-11 BUG-BS5): 后续块同样按 chunk 遍历找 data 起点（旧的
    // 字节扫描会被 LIST 内容里的字面量 "data" 误命中），失败再走旧扫描兜底。
    const offset =
      i === 0
        ? dataOffset
        : parseWavLayout(buf)?.dataOffset ?? findDataChunkOffset(buf);
    const pcm = buf.slice(offset);
    pcmChunks.push(pcm);
    totalPcmBytes += pcm.length;
  }

  // Merge PCM data and build new WAV file (header writer shared with pcmBase64ToWavBase64)
  const mergedPcm = new Uint8Array(totalPcmBytes);
  let offset = 0;
  for (const pcm of pcmChunks) {
    mergedPcm.set(pcm, offset);
    offset += pcm.length;
  }
  const result = buildWavBytesFromPcm(mergedPcm, {
    numChannels,
    sampleRate,
    bitsPerSample,
  });

  // Convert to base64
  return bytesToBase64(result);
}

// 🔧 FIX (2026-06-11 BUG-B4): MP3 帧可直接串接，多块 MP3 按字节顺序拼接即可，
// 不能走 concatenateWavBase64（会把 MP3 当 WAV 砍头）。
export function concatenateMp3Base64(mp3Base64Chunks: string[]): string {
  if (mp3Base64Chunks.length === 0) return "";
  if (mp3Base64Chunks.length === 1) return mp3Base64Chunks[0];

  const buffers = mp3Base64Chunks.map(base64ToBytes);
  const totalBytes = buffers.reduce((sum, buf) => sum + buf.length, 0);
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const buf of buffers) {
    merged.set(buf, offset);
    offset += buf.length;
  }
  return bytesToBase64(merged);
}

// ============================================================
// Phase B（VIDEO_PIPELINE_REDESIGN_PLAN §5.1 L2）：句级时间轴 + 块间淡接
// ============================================================

export interface SentenceTimelineEntry {
  text: string;
  startSec: number;
  endSec: number;
}

export interface WavSegmentInput {
  base64: string;
  text: string;
}

export interface WavConcatTimelineResult {
  base64: string;
  timeline: SentenceTimelineEntry[];
  durationSec: number;
}

/** 解析单块 WAV 的 PCM 时长（秒）；非 WAV / 解析失败返回 null。 */
export function getWavDurationSeconds(wavBase64: string): number | null {
  try {
    const bytes = base64ToBytes(wavBase64);
    if (!hasRiffMagic(bytes)) return null;
    const layout = parseWavLayout(bytes);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const numChannels = layout?.numChannels ?? view.getUint16(22, true);
    const sampleRate = layout?.sampleRate ?? view.getUint32(24, true);
    const bitsPerSample = layout?.bitsPerSample ?? view.getUint16(34, true);
    const dataOffset = layout?.dataOffset ?? findDataChunkOffset(bytes);
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    if (!byteRate || !Number.isFinite(byteRate)) return null;
    return (bytes.length - dataOffset) / byteRate;
  } catch {
    return null;
  }
}

/** 16-bit PCM 边界线性淡入/淡出（其他位深静默跳过），消除 butt-joint 接缝爆音。 */
function applyLinearFadeInPlace(
  pcm: Uint8Array,
  format: { sampleRate: number; numChannels: number; bitsPerSample: number },
  fadeMs: number,
  mode: "in" | "out"
): void {
  if (format.bitsPerSample !== 16 || fadeMs <= 0) return;
  const frameBytes = 2 * format.numChannels;
  const totalFrames = Math.floor(pcm.byteLength / frameBytes);
  const fadeFrames = Math.min(
    Math.floor((format.sampleRate * fadeMs) / 1000),
    totalFrames
  );
  if (fadeFrames <= 0) return;
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  for (let i = 0; i < fadeFrames; i++) {
    const gain = mode === "in" ? i / fadeFrames : 1 - i / fadeFrames;
    const frameIndex = mode === "in" ? i : totalFrames - fadeFrames + i;
    for (let ch = 0; ch < format.numChannels; ch++) {
      const byteIndex = frameIndex * frameBytes + ch * 2;
      if (byteIndex + 1 >= pcm.byteLength) return;
      view.setInt16(byteIndex, Math.round(view.getInt16(byteIndex, true) * gain), true);
    }
  }
}

/**
 * 拼接多块 WAV 并产出句级时间轴：
 * - 每块时长 = PCM 字节数 ÷ byteRate（毫秒级精确，替代字幕的字符数估算）；
 * - 块间插入 gapMs 静音垫片（自然停顿）；
 * - 块边界做 fadeMs 线性淡入淡出（消除非零交叉拼接的 click）。
 * 首块决定输出格式；与 concatenateWavBase64 相同的 RIFF 解析与回退语义。
 */
export function concatenateWavSegmentsWithTimeline(
  segments: WavSegmentInput[],
  opts?: { gapMs?: number; fadeMs?: number }
): WavConcatTimelineResult {
  const gapMs = Math.max(0, opts?.gapMs ?? 100);
  const fadeMs = Math.max(0, opts?.fadeMs ?? 5);
  if (segments.length === 0) {
    return { base64: "", timeline: [], durationSec: 0 };
  }

  const buffers = segments.map((segment) => base64ToBytes(segment.base64));
  const firstBuf = buffers[0];
  if (firstBuf.length < 44 || !hasRiffMagic(firstBuf)) {
    throw new Error("concatenateWavSegmentsWithTimeline: 输入不是 WAV (缺少 RIFF 头)");
  }
  const firstLayout = parseWavLayout(firstBuf);
  const view = new DataView(firstBuf.buffer, firstBuf.byteOffset, firstBuf.byteLength);
  const format = {
    numChannels: firstLayout?.numChannels ?? view.getUint16(22, true),
    sampleRate: firstLayout?.sampleRate ?? view.getUint32(24, true),
    bitsPerSample: firstLayout?.bitsPerSample ?? view.getUint16(34, true),
  };
  const byteRate = format.sampleRate * format.numChannels * (format.bitsPerSample / 8);
  const frameBytes = format.numChannels * (format.bitsPerSample / 8);
  const gapBytesRaw = Math.floor((byteRate * gapMs) / 1000);
  const gapBytes = gapBytesRaw - (gapBytesRaw % Math.max(1, frameBytes));

  const pcmChunks: Uint8Array[] = [];
  const timeline: SentenceTimelineEntry[] = [];
  let cursorSec = 0;
  let totalBytes = 0;

  for (let i = 0; i < buffers.length; i++) {
    const buf = buffers[i];
    const offset = parseWavLayout(buf)?.dataOffset ?? findDataChunkOffset(buf);
    const pcm = buf.slice(offset);
    if (i > 0) {
      applyLinearFadeInPlace(pcm, format, fadeMs, "in");
    }
    if (i < buffers.length - 1) {
      applyLinearFadeInPlace(pcm, format, fadeMs, "out");
    }
    const segmentSec = byteRate > 0 ? pcm.length / byteRate : 0;
    timeline.push({
      text: segments[i].text,
      startSec: Number(cursorSec.toFixed(3)),
      endSec: Number((cursorSec + segmentSec).toFixed(3)),
    });
    pcmChunks.push(pcm);
    totalBytes += pcm.length;
    cursorSec += segmentSec;
    if (i < buffers.length - 1 && gapBytes > 0) {
      pcmChunks.push(new Uint8Array(gapBytes));
      totalBytes += gapBytes;
      cursorSec += gapBytes / byteRate;
    }
  }

  const mergedPcm = new Uint8Array(totalBytes);
  let writeOffset = 0;
  for (const pcm of pcmChunks) {
    mergedPcm.set(pcm, writeOffset);
    writeOffset += pcm.length;
  }
  const result = buildWavBytesFromPcm(mergedPcm, format);
  return {
    base64: bytesToBase64(result),
    timeline,
    durationSec: Number(cursorSec.toFixed(3)),
  };
}

// 🔧 FIX (2026-06-11 BUG-B3): 导出 PCM→WAV 封装能力，供 gemini-tts-client 复用，
// 避免在两处复制粘贴 44 字节 WAV 头写入逻辑。
export interface PcmWavFormat {
  sampleRate: number;
  numChannels: number;
  bitsPerSample: number;
}

/** 给裸 PCM 数据加 44 字节标准 WAV 头（RIFF/fmt/data）。 */
export function buildWavBytesFromPcm(
  pcm: Uint8Array,
  format: PcmWavFormat
): Uint8Array {
  const { sampleRate, numChannels, bitsPerSample } = format;
  const headerSize = 44;
  const result = new Uint8Array(headerSize + pcm.length);
  const rv = new DataView(result.buffer);

  // RIFF header
  writeString(result, 0, "RIFF");
  rv.setUint32(4, 36 + pcm.length, true);
  writeString(result, 8, "WAVE");

  // fmt chunk
  writeString(result, 12, "fmt ");
  rv.setUint32(16, 16, true); // chunk size
  rv.setUint16(20, 1, true); // PCM format
  rv.setUint16(22, numChannels, true);
  rv.setUint32(24, sampleRate, true);
  rv.setUint32(28, sampleRate * numChannels * (bitsPerSample / 8), true);
  rv.setUint16(32, numChannels * (bitsPerSample / 8), true);
  rv.setUint16(34, bitsPerSample, true);

  // data chunk
  writeString(result, 36, "data");
  rv.setUint32(40, pcm.length, true);

  result.set(pcm, headerSize);
  return result;
}

/** base64 裸 PCM → base64 WAV（含 44 字节头）。 */
export function pcmBase64ToWavBase64(
  pcmBase64: string,
  format: PcmWavFormat
): string {
  return bytesToBase64(buildWavBytesFromPcm(base64ToBytes(pcmBase64), format));
}

function hasRiffMagic(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 // F
  );
}

// 🔧 FIX (2026-06-11 BUG-BS5): RIFF chunk 遍历结果——fmt 字段 + data chunk 数据起点
interface ParsedWavLayout {
  numChannels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataOffset: number;
}

/**
 * 🔧 FIX (2026-06-11 BUG-BS5): 按 RIFF 规范遍历 chunk 链（"WAVE" 后从偏移 12 起，
 * 每个 chunk 为 4 字节 id + 4 字节小端长度 + 数据，奇数长度补 1 字节对齐），
 * 找到 "fmt " 读取 numChannels/sampleRate/bitsPerSample，找到 "data" 返回数据起点。
 * 结构不完整（缺 fmt/data、越界）时返回 null，由调用方回退旧的固定偏移逻辑。
 */
function parseWavLayout(bytes: Uint8Array): ParsedWavLayout | null {
  if (!hasRiffMagic(bytes) || bytes.length < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let fmt: Omit<ParsedWavLayout, "dataOffset"> | null = null;

  while (offset + 8 <= bytes.length) {
    const chunkId = String.fromCharCode(
      bytes[offset],
      bytes[offset + 1],
      bytes[offset + 2],
      bytes[offset + 3]
    );
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkDataStart = offset + 8;

    if (chunkId === "fmt ") {
      if (chunkDataStart + 16 > bytes.length) return null;
      fmt = {
        numChannels: view.getUint16(chunkDataStart + 2, true),
        sampleRate: view.getUint32(chunkDataStart + 4, true),
        bitsPerSample: view.getUint16(chunkDataStart + 14, true),
      };
    } else if (chunkId === "data") {
      if (!fmt) return null;
      return { ...fmt, dataOffset: chunkDataStart };
    }

    // RIFF chunk 按 2 字节对齐：奇数长度后跟 1 个 pad 字节
    offset = chunkDataStart + chunkSize + (chunkSize % 2);
  }
  return null;
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function findDataChunkOffset(wav: Uint8Array): number {
  // Search for "data" marker
  for (let i = 12; i < wav.length - 8; i++) {
    if (
      wav[i] === 0x64 && // d
      wav[i + 1] === 0x61 && // a
      wav[i + 2] === 0x74 && // t
      wav[i + 3] === 0x61 // a
    ) {
      const view = new DataView(wav.buffer);
      const dataSize = view.getUint32(i + 4, true);
      void dataSize; // validate if needed
      return i + 8; // skip "data" + size
    }
  }
  // Fallback: assume standard 44-byte header
  return 44;
}

function writeString(buf: Uint8Array, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    buf[offset + i] = str.charCodeAt(i);
  }
}
