import { synthesize } from "@/lib/tts/synthesize";
import { audioHash, getDocument, getSegmentForTts, saveSegmentAudio } from "@/lib/store/documents";
import { errorResponse } from "@/lib/http";

/**
 * 按文档当前设置为某段合成音频，转 MP3 存盘（覆盖旧音频），返回更新后的段信息。
 * 已有且未过期的音频直接返回，不重复调用 TTS（除非 ?force=1）。
 */
export async function POST(request: Request, ctx: RouteContext<"/api/documents/[id]/segments/[idx]/tts">) {
  try {
    const { id, idx: idxStr } = await ctx.params;
    const idx = Number(idxStr);
    const force = new URL(request.url).searchParams.get("force") === "1";

    const existing = getDocument(id)?.segments[idx];
    if (!existing) return Response.json({ error: "段落不存在" }, { status: 404 });
    if (!force && existing.audioUrl && existing.audioFresh) return Response.json(existing);

    const seg = getSegmentForTts(id, idx)!;
    if (!seg.tagged.trim()) return Response.json({ error: "口述稿为空" }, { status: 400 });
    const { settings } = seg;

    const { audio, voice, mime } = await synthesize({
      text: seg.tagged,
      modelId: settings.ttsModelId,
      voice: settings.voice,
      personaId: settings.personaId,
      useStyle: settings.useStyle,
      signal: request.signal,
    });
    saveSegmentAudio(id, idx, audio, {
      hash: audioHash({ text: seg.tagged, modelId: settings.ttsModelId, voice: settings.voice, useStyle: settings.useStyle, personaId: settings.personaId }),
      modelId: settings.ttsModelId,
      voice,
      ext: mime === "audio/mpeg" ? "mp3" : mime === "audio/wav" ? "wav" : "bin",
    });
    return Response.json(getDocument(id)!.segments[idx]);
  } catch (e) {
    return errorResponse(e);
  }
}
