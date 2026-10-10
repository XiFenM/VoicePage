import "server-only";
import { Mp3Encoder } from "@breezystack/lamejs";

export const MP3_KBPS = 64; // 单声道人声 64kbps 足够清晰，约 0.47MB/分钟

/** 16bit LE PCM -> MP3 */
export function pcmToMp3(pcm: Buffer, sampleRate: number, channels = 1): Buffer {
  // Int16Array 需要 2 字节对齐，复制一份保证对齐
  const aligned = Buffer.alloc(pcm.length - (pcm.length % 2));
  pcm.copy(aligned, 0, 0, aligned.length);
  const samples = new Int16Array(aligned.buffer, aligned.byteOffset, aligned.length / 2);

  const enc = new Mp3Encoder(channels, sampleRate, MP3_KBPS);
  const chunks: Uint8Array[] = [];
  const BLOCK = 1152 * 8;

  if (channels === 1) {
    for (let i = 0; i < samples.length; i += BLOCK) chunks.push(enc.encodeBuffer(samples.subarray(i, i + BLOCK)));
  } else {
    // 交错立体声拆成左右声道
    const frames = Math.floor(samples.length / 2);
    const left = new Int16Array(frames);
    const right = new Int16Array(frames);
    for (let i = 0; i < frames; i++) {
      left[i] = samples[i * 2];
      right[i] = samples[i * 2 + 1];
    }
    for (let i = 0; i < frames; i += BLOCK) {
      chunks.push(enc.encodeBuffer(left.subarray(i, i + BLOCK), right.subarray(i, i + BLOCK)));
    }
  }
  chunks.push(enc.flush());
  return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
}

/** 粗略估算 MP3 时长（CBR） */
export function mp3DurationMs(bytes: number): number {
  return Math.round((bytes * 8) / MP3_KBPS);
}
