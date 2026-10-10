import assert from "node:assert/strict";
import test from "node:test";
import {
  backgroundPercent, backgroundStatusText, documentProgress,
  editedSinceSnapshot, formatBackgroundElapsed, isBackgroundActive, mergeDocumentSnapshot,
} from "../src/components/background-progress.ts";

const progress = (patch = {}) => ({
  status: "running", phase: "segments", scriptReady: true,
  totalSegments: 2, completedSegments: 0, queuedSegments: 0,
  taggingSegments: 1, speakingSegments: 1, failedSegments: 0,
  startedAt: 1_000, updatedAt: 2_000, ...patch,
});
const segment = (idx, patch = {}) => ({
  idx, kind: "text", markdown: `原文 ${idx}`, speech: `口述 ${idx}`, tagged: `口述 ${idx}`,
  tagStatus: "pending", generation: { status: "running", phase: "tags" }, ...patch,
});
const document = (patch = {}) => ({
  id: "doc-a", title: "测试记录", sourceText: "原文", personaId: "teacher", ttsModelId: "model-a",
  voice: "voice-a", useTags: true, useStyle: true, createdAt: 1_000, updatedAt: 2_000,
  generation: progress(), segments: [segment(0), segment(1)], ...patch,
});

test("轮询更新其他段的标签和语音，同时保留尚未保存的手工稿", () => {
  const current = document({ segments: [segment(0, { speech: "我的改稿", tagged: "我的改稿", tagStatus: "manual" }), segment(1)] });
  const incoming = document({
    generation: progress({ updatedAt: 3_000, completedSegments: 2, status: "completed" }),
    segments: [segment(0, { tagged: "远程标签稿", tagStatus: "ready", audioUrl: "/old-audio", audioFresh: true }), segment(1, { tagged: "标签稿 1", tagStatus: "ready", audioUrl: "/audio-1", audioFresh: true })],
  });
  const merged = mergeDocumentSnapshot(current, incoming, new Set([0]));
  assert.equal(merged.segments[0].tagged, "我的改稿");
  assert.equal(merged.segments[0].speech, "我的改稿");
  assert.equal(merged.segments[0].tagStatus, "manual");
  assert.equal(merged.segments[0].audioFresh, false);
  assert.equal(merged.segments[1].tagged, "标签稿 1");
  assert.equal(merged.segments[1].audioUrl, "/audio-1");
  assert.equal(merged.generation.completedSegments, 2);
  assert.equal(incoming.segments[0].tagged, "远程标签稿");
});

test("保存完成后读取服务端确认稿，保留正在播放段的同一音频 URL", () => {
  const current = document({ segments: [segment(0, { audioUrl: "/audio?v=same", audioFresh: true }), segment(1)] });
  const incoming = document({
    generation: progress({ updatedAt: 4_000 }),
    segments: [segment(0, { audioUrl: "/audio?v=same", audioFresh: true }), segment(1, { tagged: "手工稿已保存", tagStatus: "manual" })],
  });
  const merged = mergeDocumentSnapshot(current, incoming, new Set());
  assert.equal(merged.segments[0].audioUrl, current.segments[0].audioUrl);
  assert.equal(merged.segments[1].tagged, "手工稿已保存");
  assert.equal("current" in merged, false);
  assert.equal("playing" in merged, false);
});

test("设置或队列操作的旧响应晚到，期间已经保存成功的手工稿也不能被覆盖", () => {
  const editsAtRequest = { 0: 1, 1: 2 };
  const editsNow = { 0: 2, 1: 2 };
  // 自动保存已完成，unsaved/saveRequests 均为空，但请求期间改过的段仍受保护。
  const current = document({ segments: [segment(0, { speech: "新稿已保存", tagged: "新稿已保存", tagStatus: "manual" }), segment(1)] });
  const lateSettingsResponse = document({
    voice: "new-voice",
    segments: [segment(0, { tagged: "请求开始时的旧稿", tagStatus: "manual" }), segment(1, { tagged: "未编辑段的新标签", tagStatus: "ready" })],
  });
  const protectedIndices = editedSinceSnapshot(editsNow, editsAtRequest);
  assert.deepEqual([...protectedIndices], [0]);
  const merged = mergeDocumentSnapshot(current, lateSettingsResponse, protectedIndices);
  assert.equal(merged.voice, "new-voice");
  assert.equal(merged.segments[0].tagged, "新稿已保存");
  assert.equal(merged.segments[0].speech, "新稿已保存");
  assert.equal(merged.segments[0].tagStatus, "manual");
  assert.equal(merged.segments[1].tagged, "未编辑段的新标签");
});

test("过时进度快照不能让已完成段退回缺失状态", () => {
  const current = document({ generation: progress({ updatedAt: 9_000, completedSegments: 2, status: "completed" }) });
  const outdated = document({ generation: progress({ updatedAt: 8_000 }) });
  assert.equal(mergeDocumentSnapshot(current, outdated, new Set()), current);
  assert.equal(mergeDocumentSnapshot(current, document({ id: "another-doc" }), new Set()), current);
});

test("后台口述稿完成后，草稿原地接入分段数据", () => {
  const draft = document({ segments: [], generation: progress({ phase: "spoken", scriptReady: false, totalSegments: 0 }) });
  const incoming = document({ generation: progress({ updatedAt: 3_000 }) });
  const merged = mergeDocumentSnapshot(draft, incoming, new Set());
  assert.equal(merged.id, draft.id);
  assert.equal(merged.generation.scriptReady, true);
  assert.equal(merged.segments.length, 2);
});

test("旧记录没有任务时为 idle，缺失音频不会被解释成已排队", () => {
  const legacy = document({ generation: undefined, segments: [segment(0, { generation: undefined })] });
  const value = documentProgress(legacy);
  assert.equal(value.status, "idle");
  assert.equal(value.queuedSegments, 0);
  assert.equal(isBackgroundActive(value), false);
  assert.equal(backgroundStatusText(value), "待生成");
});

test("历史状态明确区分口述稿、语音进度、失败和停止", () => {
  assert.equal(backgroundStatusText(progress({ phase: "spoken", scriptReady: false })), "口述稿生成中");
  assert.equal(backgroundStatusText(progress({ completedSegments: 1 })), "语音 1/2");
  assert.equal(backgroundStatusText(progress({ status: "cancelled" })), "已停止");
  assert.equal(backgroundStatusText(progress({ status: "failed", failedSegments: 1 })), "生成失败 · 1 段");
  assert.equal(backgroundStatusText(progress({ status: "queued" })), "排队中");
});

test("草稿和空队列不显示虚假完成比例，正常进度按服务端完成段数", () => {
  assert.equal(backgroundPercent(progress({ scriptReady: false, totalSegments: 0 })), 0);
  assert.equal(backgroundPercent(progress({ totalSegments: 0, completedSegments: 0 })), 0);
  assert.equal(backgroundPercent(progress({ completedSegments: 1 })), 50);
  assert.equal(backgroundPercent(progress({ completedSegments: 10 })), 100);
  assert.equal(formatBackgroundElapsed(-1_000), "0 秒");
  assert.equal(formatBackgroundElapsed(75_000), "1 分 15 秒");
});
