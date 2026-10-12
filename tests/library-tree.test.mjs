import assert from "node:assert/strict";
import test from "node:test";
import { childNodes, libraryDropMove, libraryNodes, libraryStepMove, sessionLabels, siblingNodes } from "../src/components/library-tree.ts";

const collection = (id, kind, parentId, position) => ({ id, name: id, kind, parentId, position, createdAt: 1, updatedAt: 1 });
const doc = (id, sessionId, position) => ({ id, title: id, sessionId, position });
const library = {
  collections: [
    collection("group-a", "group", null, 0), collection("root-session", "session", null, 1), collection("group-b", "group", null, 2),
    collection("session-a", "session", "group-a", 0), collection("session-b", "session", "group-a", 1), collection("session-c", "session", "group-b", 0),
  ],
  documents: [doc("a1", "session-a", 0), doc("a2", "session-a", 1), doc("a3", "session-a", 2), doc("b1", "session-b", 0), doc("loose", null, 0)],
};
const nodes = libraryNodes(library);
const node = (id) => nodes.find((item) => item.id === id);

test("Group 和根 Session 按同一顺序混排，未归档文档不混进顶层集合", () => {
  assert.deepEqual(childNodes(nodes, "root", null).map((item) => item.id), ["group-a", "root-session", "group-b"]);
  assert.deepEqual(childNodes(nodes, "group", "group-a").map((item) => item.id), ["session-a", "session-b"]);
  assert.deepEqual(childNodes(nodes, "unfiled", null).map((item) => item.id), ["loose"]);
  assert.deepEqual(siblingNodes(nodes, node("group-a")).map((item) => item.id), ["group-a", "root-session", "group-b"]);
});

test("同一 Session 内拖到后方会排除源节点，使用正确的 beforeId", () => {
  const result = libraryDropMove(nodes, node("a1"), { type: "edge", node: node("a2"), edge: "after" });
  assert.deepEqual(result, { kind: "document", id: "a1", parentId: "session-a", beforeId: "a3" });
  const last = libraryDropMove(nodes, node("a1"), { type: "edge", node: node("a3"), edge: "after" });
  assert.equal(last.beforeId, null);
});

test("跨 Session 拖到文档前面同时改变归属和排序", () => {
  assert.deepEqual(libraryDropMove(nodes, node("a2"), { type: "edge", node: node("b1"), edge: "before" }), {
    kind: "document", id: "a2", parentId: "session-b", beforeId: "b1",
  });
});

test("拖到 Session 容器末尾与拖回未归档产生不同父级", () => {
  assert.deepEqual(libraryDropMove(nodes, node("loose"), { type: "inside", kind: "session", id: "session-a" }), {
    kind: "document", id: "loose", parentId: "session-a", beforeId: null,
  });
  assert.deepEqual(libraryDropMove(nodes, node("a1"), { type: "inside", kind: "unfiled", id: null }), {
    kind: "document", id: "a1", parentId: null, beforeId: null,
  });
});

test("Session 可以跨 Group 或升到根级，也可插到根 Group 前面", () => {
  assert.equal(libraryDropMove(nodes, node("session-a"), { type: "inside", kind: "group", id: "group-b" }).parentId, "group-b");
  assert.equal(libraryDropMove(nodes, node("session-a"), { type: "inside", kind: "root", id: null }).parentId, null);
  assert.deepEqual(libraryDropMove(nodes, node("session-a"), { type: "edge", node: node("group-b"), edge: "before" }), {
    kind: "session", id: "session-a", parentId: null, beforeId: "group-b",
  });
});

test("Group 可以在根级重排，但不能嵌套到其他 Group 或 Session", () => {
  assert.deepEqual(libraryDropMove(nodes, node("group-b"), { type: "edge", node: node("root-session"), edge: "before" }), {
    kind: "group", id: "group-b", parentId: null, beforeId: "root-session",
  });
  assert.equal(libraryDropMove(nodes, node("group-a"), { type: "inside", kind: "group", id: "group-b" }), null);
  assert.equal(libraryDropMove(nodes, node("group-a"), { type: "edge", node: node("session-c"), edge: "before" }), null);
});

test("非法跨类型父级和拖到自身不会发送移动操作", () => {
  assert.equal(libraryDropMove(nodes, node("a1"), { type: "inside", kind: "group", id: "group-a" }), null);
  assert.equal(libraryDropMove(nodes, node("a1"), { type: "inside", kind: "root", id: null }), null);
  assert.equal(libraryDropMove(nodes, node("session-a"), { type: "inside", kind: "session", id: "session-b" }), null);
  assert.equal(libraryDropMove(nodes, node("session-a"), { type: "inside", kind: "unfiled", id: null }), null);
  assert.equal(libraryDropMove(nodes, node("a1"), { type: "edge", node: node("a1"), edge: "before" }), null);
  assert.equal(libraryDropMove(nodes, node("a1"), { type: "edge", node: node("root-session"), edge: "before" }), null);
});

test("上下移动和拖拽使用同一排序语义，边界按钮不产生移动", () => {
  assert.equal(libraryStepMove(nodes, node("a1"), -1), null);
  assert.equal(libraryStepMove(nodes, node("a3"), 1), null);
  assert.equal(libraryStepMove(nodes, node("a2"), -1).beforeId, "a1");
  assert.equal(libraryStepMove(nodes, node("a1"), 1).beforeId, "a3");
  assert.equal(libraryStepMove(nodes, node("a2"), 1).beforeId, null);
  assert.equal(libraryStepMove(nodes, node("group-b"), -1).beforeId, "root-session");
});

test("Session 选择器展示 Group 路径，不改变原始快照", () => {
  const before = JSON.stringify(library);
  assert.deepEqual(sessionLabels(library).find((item) => item.id === "session-a"), { id: "session-a", label: "group-a / session-a" });
  assert.deepEqual(sessionLabels(library).find((item) => item.id === "root-session"), { id: "root-session", label: "root-session" });
  childNodes(nodes, "root", null);
  assert.equal(JSON.stringify(library), before);
});
