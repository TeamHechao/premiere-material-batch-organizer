const test = require("node:test");
const assert = require("node:assert/strict");
const Premiere = require("../src/premiere-adapter");

const source = "C:\\Downloads\\sound.wav";
const target = "E:\\Project\\素材\\batch\\sound.wav";

function media(id, path = target, overrides = {}) {
  return { kind: "clip", name: id, getId: async () => id,
    isSequence: async () => false, isMergedClip: async () => false,
    isMulticamClip: async () => false, getMediaFilePath: async () => path, ...overrides };
}

function trackItem(item, overrides = {}) {
  return { getProjectItem: async () => item, isAdjustmentLayer: async () => false, ...overrides };
}

function sequence(guid, video = [], audio = []) {
  return { guid, name: guid,
    getVideoTrackCount: async () => 1, getAudioTrackCount: async () => 1,
    getVideoTrack: async () => ({ getTrackItems: async () => video }),
    getAudioTrack: async () => ({ getTrackItems: async () => audio }) };
}

function fixture(projectItems, sequences, overrides = {}) {
  const project = { getRootItem: async () => ({ getItems: async () => projectItems }),
    getSequences: async () => sequences };
  const ppro = { Constants: { TrackItemType: { CLIP: 1 } },
    FolderItem: { cast: async () => null },
    ClipProjectItem: { cast: async item => item && item.kind === "clip" ? item : null }, ...overrides };
  return { project, ppro };
}

test("时间线中的已识别非媒体项不阻止已补链文件回收，不依赖条目名称", async () => {
  const clip = media("media");
  const style = { getId: async () => "style", name: "sound.wav" };
  const f = fixture([clip, style], [sequence("seq", [trackItem(style)], [trackItem(clip)])]);
  const inventory = await Premiere.inventoryProject(f.ppro, f.project);
  assert.deepEqual(inventory.nonMediaItems.map(item => item.itemId), ["style"]);
  await Premiere.verifyNoTimelineSourceReferences(f.ppro, f.project, source, "", inventory);
});

test("明确为调整图层的轨道项无文件来源，不要求它转换成普通媒体", async () => {
  const clip = media("media");
  const layer = trackItem(null, { isAdjustmentLayer: async () => true,
    getProjectItem: async () => { assert.fail("调整图层不读取外部素材路径"); } });
  const f = fixture([clip], [sequence("seq", [layer], [trackItem(clip)])]);
  await Premiere.verifyNoTimelineSourceReferences(f.ppro, f.project, source);
});

test("未知空媒体转换、没有项目项或缺少身份的轨道项仍阻止回收", async () => {
  for (const raw of [null, { getId: async () => "unknown" }, {}, { getId: async () => "" }]) {
    const f = fixture([], [sequence("seq", [trackItem(raw)])]);
    await assert.rejects(Premiere.verifyNoTimelineSourceReferences(f.ppro, f.project, source),
      error => error.code === "MATERIAL_BATCH_TIMELINE_UNREADABLE" && /视频轨 1/.test(error.message));
  }
});

test("时间线类型读取拒绝不是非媒体，保存原始原因且标出实际位置", async () => {
  const known = media("media");
  const raw = { getId: async () => "raw", name: "不可读轨道项" };
  const f = fixture([known], [sequence("seq", [trackItem(raw)])], {
    ClipProjectItem: { cast: async item => { if (item === raw) throw new Error("host unavailable"); return known; } }
  });
  await assert.rejects(Premiere.verifyNoTimelineSourceReferences(f.ppro, f.project, source),
    error => error.code === "MATERIAL_BATCH_TIMELINE_UNREADABLE"
      && /不可读轨道项/.test(error.message) && /host unavailable/.test(error.cause.message));
});

test("调整图层和序列检查必须是明确布尔值，不能把未知状态当成安全", async () => {
  for (const value of [undefined, null, "true", 1]) {
    const clip = media("media", target, { isSequence: async () => value });
    const f = fixture([], [sequence("seq", [trackItem(clip)])]);
    await assert.rejects(Premiere.verifyNoTimelineSourceReferences(f.ppro, f.project, source),
      { code: "MATERIAL_BATCH_TIMELINE_UNREADABLE" });
    const adjusted = fixture([], [sequence("seq", [trackItem(clip, { isAdjustmentLayer: async () => value })])]);
    await assert.rejects(Premiere.verifyNoTimelineSourceReferences(adjusted.ppro, adjusted.project, source),
      { code: "MATERIAL_BATCH_TIMELINE_UNREADABLE" });
  }
});

test("嵌套序列、其他序列与音轨中的原位置引用都必须阻止回收", async () => {
  for (const path of [source, source + ".pending-delete", "\\\\?\\" + source]) {
    const original = media("original", path);
    const child = sequence("child", [], [trackItem(original)]);
    const nested = media("nested", "", { isSequence: async () => true, getSequence: async () => child });
    const f = fixture([original, nested], [sequence("main", [trackItem(nested)]), child]);
    await assert.rejects(Premiere.verifyNoTimelineSourceReferences(f.ppro, f.project, source, source + ".pending-delete"),
      /时间线仍引用原位置/);
  }
});

test("循环嵌套序列只检查一次且已补链引用可通过", async () => {
  const clip = media("media");
  const child = sequence("child", [], [trackItem(clip)]);
  const nested = media("nested", "", { isSequence: async () => true, getSequence: async () => child });
  child.getVideoTrack = async () => ({ getTrackItems: async () => [trackItem(nested)] });
  const f = fixture([clip, nested], [child, child]);
  await Premiere.verifyNoTimelineSourceReferences(f.ppro, f.project, source);
});

test("合并或不可展开的多机位素材不只凭可见路径通过回收检查", async () => {
  for (const flag of ["isMergedClip", "isMulticamClip"]) {
    const clip = media("media", target, { [flag]: async () => true });
    const f = fixture([clip], [sequence("seq", [trackItem(clip)])]);
    await assert.rejects(Premiere.verifyNoTimelineSourceReferences(f.ppro, f.project, source), /合并|多机位/);
  }
});

test("不完整素材清单不能成为非媒体豁免的凭据", async () => {
  const f = fixture([], [sequence("seq")]);
  await assert.rejects(Premiere.verifyNoTimelineSourceReferences(f.ppro, f.project, source, "",
    { entries: [], nonMediaItems: [{ itemId: "style" }], warnings: ["unreadable"] }),
    { code: "MATERIAL_BATCH_INVENTORY_INCOMPLETE" });
});

test("项目媒体转换的 undefined 结果不是已确认非媒体", async () => {
  const raw = { getId: async () => "unknown" };
  const f = fixture([raw], [], { ClipProjectItem: { cast: async () => undefined } });
  const inventory = await Premiere.inventoryProject(f.ppro, f.project);
  assert.throws(() => Premiere.assertCompleteInventory(inventory), { code: "MATERIAL_BATCH_INVENTORY_INCOMPLETE" });
});
