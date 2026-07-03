/**
 * 🔧 FIX (2026-06-11 BUG-B3/B4) 配套单测：
 * - pcmBase64ToWavBase64 / buildWavBytesFromPcm：44 字节 WAV 头正确性
 *   （RIFF magic、采样率、byteRate/blockAlign、RIFF/data 长度字段）
 * - concatenateWavBase64：首块非 WAV（缺 RIFF 头）抛错而不是产出垃圾
 * - concatenateMp3Base64：MP3 帧按字节顺序直接拼接
 */
import {
  buildWavBytesFromPcm,
  concatenateMp3Base64,
  concatenateWavBase64,
  pcmBase64ToWavBase64,
} from "../text-chunker";

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

const base64ToBytes = (b64: string): Uint8Array => {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

const readAscii = (bytes: Uint8Array, offset: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(offset, offset + length));

describe("pcmBase64ToWavBase64 (BUG-B3)", () => {
  it("writes a standard 44-byte WAV header around raw PCM", () => {
    const pcm = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const wavBase64 = pcmBase64ToWavBase64(bytesToBase64(pcm), {
      sampleRate: 24000,
      numChannels: 1,
      bitsPerSample: 16,
    });
    const wav = base64ToBytes(wavBase64);
    const view = new DataView(wav.buffer);

    expect(wav.length).toBe(44 + pcm.length);
    expect(readAscii(wav, 0, 4)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + pcm.length); // RIFF chunk size
    expect(readAscii(wav, 8, 4)).toBe("WAVE");
    expect(readAscii(wav, 12, 4)).toBe("fmt ");
    expect(view.getUint32(16, true)).toBe(16); // fmt chunk size
    expect(view.getUint16(20, true)).toBe(1); // PCM format
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(24000); // sample rate
    expect(view.getUint32(28, true)).toBe(24000 * 1 * (16 / 8)); // byte rate
    expect(view.getUint16(32, true)).toBe(1 * (16 / 8)); // block align
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(readAscii(wav, 36, 4)).toBe("data");
    expect(view.getUint32(40, true)).toBe(pcm.length); // data chunk size
    expect(Array.from(wav.subarray(44))).toEqual(Array.from(pcm));
  });

  it("respects a non-default sample rate", () => {
    const pcm = new Uint8Array([9, 8, 7, 6]);
    const wav = base64ToBytes(
      pcmBase64ToWavBase64(bytesToBase64(pcm), {
        sampleRate: 16000,
        numChannels: 1,
        bitsPerSample: 16,
      })
    );
    const view = new DataView(wav.buffer);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(28, true)).toBe(16000 * 2);
  });

  it("buildWavBytesFromPcm output passes concatenateWavBase64 RIFF check", () => {
    const wavA = buildWavBytesFromPcm(new Uint8Array([1, 2]), {
      sampleRate: 24000,
      numChannels: 1,
      bitsPerSample: 16,
    });
    expect(readAscii(wavA, 0, 4)).toBe("RIFF");
  });
});

describe("concatenateWavBase64 RIFF validation (BUG-B4)", () => {
  it("throws on non-WAV first chunk instead of producing garbage", () => {
    // 伪 MP3：0xFF 0xFB 帧头 + 填充（长度 ≥44 以越过最小长度检查，命中 RIFF 校验）
    const fakeMp3 = new Uint8Array(64);
    fakeMp3[0] = 0xff;
    fakeMp3[1] = 0xfb;
    const chunk = bytesToBase64(fakeMp3);
    expect(() => concatenateWavBase64([chunk, chunk])).toThrow(
      "concatenateWavBase64: 输入不是 WAV (缺少 RIFF 头)"
    );
  });

  it("keeps single-chunk passthrough behavior (backward compat)", () => {
    const fakeMp3 = bytesToBase64(new Uint8Array(64).fill(0xfb));
    expect(concatenateWavBase64([fakeMp3])).toBe(fakeMp3);
  });

  it("still merges valid WAV chunks and preserves header fields", () => {
    const pcmA = new Uint8Array([1, 2, 3, 4]);
    const pcmB = new Uint8Array([5, 6]);
    const format = { sampleRate: 24000, numChannels: 1, bitsPerSample: 16 };
    const merged = base64ToBytes(
      concatenateWavBase64([
        pcmBase64ToWavBase64(bytesToBase64(pcmA), format),
        pcmBase64ToWavBase64(bytesToBase64(pcmB), format),
      ])
    );
    const view = new DataView(merged.buffer);

    expect(readAscii(merged, 0, 4)).toBe("RIFF");
    expect(view.getUint32(24, true)).toBe(24000);
    expect(view.getUint32(40, true)).toBe(pcmA.length + pcmB.length);
    expect(Array.from(merged.subarray(44))).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

// 🔧 FIX (2026-06-11 BUG-BS5) 配套单测：带 LIST chunk 的非标准 WAV
describe("concatenateWavBase64 with non-44-byte headers (BUG-BS5)", () => {
  const writeAscii = (bytes: Uint8Array, offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) {
      bytes[offset + i] = text.charCodeAt(i);
    }
  };

  /**
   * 构造 RIFF/WAVE 布局：LIST 在 fmt 之前，且 LIST 内容里故意包含字面量 "data"。
   * - 旧实现按固定偏移 22/24/34 读 fmt 字段 → 会读到 LIST 内容（垃圾值）
   * - 旧实现按字节扫描 "data" 找 PCM 起点 → 会被 LIST 内容里的 "data" 误命中
   * 新实现按 chunk 遍历应全部读取正确。
   */
  const buildWavWithListChunk = (
    pcm: Uint8Array,
    format: { sampleRate: number; numChannels: number; bitsPerSample: number }
  ): Uint8Array => {
    const listBody = "INFOdata-fake-payload!"; // 22 字节（偶数，含字面量 "data"）
    const listSize = listBody.length;
    const fmtSize = 16;
    const total = 12 + (8 + listSize) + (8 + fmtSize) + (8 + pcm.length);
    const bytes = new Uint8Array(total);
    const view = new DataView(bytes.buffer);

    writeAscii(bytes, 0, "RIFF");
    view.setUint32(4, total - 8, true);
    writeAscii(bytes, 8, "WAVE");

    let offset = 12;
    writeAscii(bytes, offset, "LIST");
    view.setUint32(offset + 4, listSize, true);
    writeAscii(bytes, offset + 8, listBody);
    offset += 8 + listSize;

    writeAscii(bytes, offset, "fmt ");
    view.setUint32(offset + 4, fmtSize, true);
    view.setUint16(offset + 8, 1, true); // PCM format
    view.setUint16(offset + 10, format.numChannels, true);
    view.setUint32(offset + 12, format.sampleRate, true);
    view.setUint32(
      offset + 16,
      format.sampleRate * format.numChannels * (format.bitsPerSample / 8),
      true
    );
    view.setUint16(
      offset + 20,
      format.numChannels * (format.bitsPerSample / 8),
      true
    );
    view.setUint16(offset + 22, format.bitsPerSample, true);
    offset += 8 + fmtSize;

    writeAscii(bytes, offset, "data");
    view.setUint32(offset + 4, pcm.length, true);
    bytes.set(pcm, offset + 8);
    return bytes;
  };

  it("walks RIFF chunks to read fmt fields and data offset when a LIST chunk is present", () => {
    const format = { sampleRate: 32000, numChannels: 2, bitsPerSample: 16 };
    const pcmA = new Uint8Array([1, 2, 3, 4]);
    const pcmB = new Uint8Array([5, 6, 7, 8]);
    const merged = base64ToBytes(
      concatenateWavBase64([
        bytesToBase64(buildWavWithListChunk(pcmA, format)),
        bytesToBase64(buildWavWithListChunk(pcmB, format)),
      ])
    );
    const view = new DataView(merged.buffer);

    expect(readAscii(merged, 0, 4)).toBe("RIFF");
    // fmt 字段取自真实 "fmt " chunk（旧固定偏移会读到 LIST 内容）
    expect(view.getUint16(22, true)).toBe(2); // numChannels
    expect(view.getUint32(24, true)).toBe(32000); // sampleRate
    expect(view.getUint16(34, true)).toBe(16); // bitsPerSample
    // PCM 取自真实 "data" chunk（旧字节扫描会误命中 LIST 内容里的 "data"）
    expect(view.getUint32(40, true)).toBe(pcmA.length + pcmB.length);
    expect(Array.from(merged.subarray(44))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("merges a LIST-chunk WAV with a standard 44-byte-header WAV", () => {
    const format = { sampleRate: 24000, numChannels: 1, bitsPerSample: 16 };
    const pcmA = new Uint8Array([9, 8]);
    const pcmB = new Uint8Array([7, 6]);
    const merged = base64ToBytes(
      concatenateWavBase64([
        bytesToBase64(buildWavWithListChunk(pcmA, format)),
        pcmBase64ToWavBase64(bytesToBase64(pcmB), format),
      ])
    );
    const view = new DataView(merged.buffer);

    expect(view.getUint32(24, true)).toBe(24000);
    expect(Array.from(merged.subarray(44))).toEqual([9, 8, 7, 6]);
  });
});

describe("concatenateMp3Base64 (BUG-B4)", () => {
  it("concatenates chunks byte-for-byte in order", () => {
    const a = new Uint8Array([0xff, 0xfb, 1, 2]);
    const b = new Uint8Array([0xff, 0xfb, 3]);
    const merged = base64ToBytes(
      concatenateMp3Base64([bytesToBase64(a), bytesToBase64(b)])
    );
    expect(Array.from(merged)).toEqual([0xff, 0xfb, 1, 2, 0xff, 0xfb, 3]);
  });

  it("returns single chunk as-is and empty string for empty input", () => {
    const only = bytesToBase64(new Uint8Array([0xff, 0xfb, 9]));
    expect(concatenateMp3Base64([only])).toBe(only);
    expect(concatenateMp3Base64([])).toBe("");
  });
});

// ============================================================
// Phase A/B（VIDEO_PIPELINE_REDESIGN_PLAN §5.1 L2）配套单测
// ============================================================

import {
  chunkText,
  concatenateWavSegmentsWithTimeline,
  getWavDurationSeconds,
} from "../text-chunker";

describe("chunkText 数字上下文守卫 (Phase A)", () => {
  it("不在小数点/版本号中间切分", () => {
    const head = "项目预算约为三点一四亿元，".repeat(3);
    const text = `${head}增长率达到 3.14159 个百分点，${"后续说明文字。".repeat(20)}`;
    const chunks = chunkText(text, head.length + 14);
    for (const chunk of chunks) {
      expect(chunk).not.toMatch(/3\.$/);
      expect(chunk).not.toMatch(/^14159/);
    }
  });

  it("普通中文句末仍正常切分", () => {
    const text = `${"第一句内容。".repeat(10)}${"第二句内容。".repeat(10)}`;
    const chunks = chunkText(text, 40);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].endsWith("。")).toBe(true);
  });
});

describe("concatenateWavSegmentsWithTimeline (Phase B)", () => {
  const makeWav = (pcmBytes: number, sampleRate = 1000) =>
    pcmBase64ToWavBase64(bytesToBase64(new Uint8Array(pcmBytes)), {
      sampleRate,
      numChannels: 1,
      bitsPerSample: 16,
    });

  it("按 PCM 字节级时长构造句级时间轴并插入静音垫片", () => {
    // byteRate = 1000 * 1 * 2 = 2000 B/s → 2000 字节 = 1 秒
    const result = concatenateWavSegmentsWithTimeline(
      [
        { base64: makeWav(2000), text: "第一句" },
        { base64: makeWav(4000), text: "第二句" },
      ],
      { gapMs: 100, fadeMs: 0 }
    );
    expect(result.timeline).toHaveLength(2);
    expect(result.timeline[0]).toEqual({ text: "第一句", startSec: 0, endSec: 1 });
    // 第二句起点 = 1s + 0.1s 垫片
    expect(result.timeline[1].startSec).toBeCloseTo(1.1, 2);
    expect(result.timeline[1].endSec).toBeCloseTo(3.1, 2);
    expect(result.durationSec).toBeCloseTo(3.1, 2);
    // 产物时长可被 getWavDurationSeconds 复核
    expect(getWavDurationSeconds(result.base64)).toBeCloseTo(3.1, 2);
  });

  it("非 WAV 输入抛错（与 concatenateWavBase64 同语义）", () => {
    expect(() =>
      concatenateWavSegmentsWithTimeline([
        { base64: bytesToBase64(new Uint8Array(64).fill(0xff)), text: "x" },
      ])
    ).toThrow(/RIFF/);
  });

  it("getWavDurationSeconds 对非 WAV 返回 null", () => {
    expect(getWavDurationSeconds(bytesToBase64(new Uint8Array([1, 2, 3])))).toBeNull();
  });
});
