/**
 * Text chunker for TTS - splits long text into manageable chunks
 * and provides WAV audio concatenation utilities.
 */

const SENTENCE_TERMINATORS = /([。！？!?.;\n])/;

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
      if (SENTENCE_TERMINATORS.test(window[i])) {
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

  const buffers = wavBase64Chunks.map((b64) => {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  });

  // Parse header from first WAV
  const firstBuf = buffers[0];
  if (firstBuf.length < 44) {
    throw new Error("First WAV chunk is too small to contain a valid header");
  }

  const view = new DataView(firstBuf.buffer);
  const numChannels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);

  // Find data chunk offset in first file
  const dataOffset = findDataChunkOffset(firstBuf);

  // Collect PCM data from all chunks
  const pcmChunks: Uint8Array[] = [];
  let totalPcmBytes = 0;

  for (let i = 0; i < buffers.length; i++) {
    const buf = buffers[i];
    const offset = i === 0 ? dataOffset : findDataChunkOffset(buf);
    const pcm = buf.slice(offset);
    pcmChunks.push(pcm);
    totalPcmBytes += pcm.length;
  }

  // Build new WAV file
  const headerSize = 44;
  const result = new Uint8Array(headerSize + totalPcmBytes);
  const rv = new DataView(result.buffer);

  // RIFF header
  writeString(result, 0, "RIFF");
  rv.setUint32(4, 36 + totalPcmBytes, true);
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
  rv.setUint32(40, totalPcmBytes, true);

  // Copy PCM data
  let offset = headerSize;
  for (const pcm of pcmChunks) {
    result.set(pcm, offset);
    offset += pcm.length;
  }

  // Convert to base64
  let binary = "";
  for (let i = 0; i < result.length; i++) {
    binary += String.fromCharCode(result[i]);
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
