(function (root, factory) {
  "use strict";
  var api = factory(typeof module !== "undefined" && module.exports ? require("./core") : root.MaterialBatchCore);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MaterialBatchWorkspace = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (Core) {
  "use strict";
  async function inspectExistingMedia(fs, root) {
    var mediaPath = Core.joinNativePath(root, "素材"), exists = false;
    try {
      var stat = await fs.lstat(mediaPath);
      if (!stat.isDirectory() || (stat.isSymbolicLink && stat.isSymbolicLink())) throw new Error("工程里的“素材”位置不是普通文件夹，请检查这个路径");
      exists = true;
    } catch (error) { if (!Core.isMissingPathError(error)) throw error; }
    // 普通素材目录不是丢失事务的证据。只有明确的插件遗留物才要求恢复。
    var names = await fs.readdir(root);
    var artifacts = names.map(function (entry) { return typeof entry === "string" ? entry : entry.name; })
      .filter(function (name) { return /^\.premiere-material-space\.json\./.test(name || ""); });
    var credentialPath = Core.joinNativePath(root, ".premiere-material-recycle");
    try {
      var credentials = await fs.readdir(credentialPath);
      if (credentials.length) artifacts.push(".premiere-material-recycle");
    } catch (error) { if (!Core.isMissingPathError(error)) throw error; }
    if (artifacts.length) {
      var lost = new Error("找到旧整理凭据，但工程记录和备份已丢失。已有素材保持原位，需要恢复记录后继续；可正常打开文件夹和查看名单。");
      lost.code = "MATERIAL_BATCH_STATE_LOST"; lost.artifacts = artifacts;
      throw lost;
    }
    return { existingMedia: exists };
  }
  async function nearestDirectory(fs, candidates) {
    for (var i = 0; i < candidates.length; i++) {
      if (!candidates[i]) continue;
      try {
        var stat = await fs.lstat(candidates[i]);
        if (!stat.isDirectory() || (stat.isSymbolicLink && stat.isSymbolicLink())) throw new Error("要打开的位置不是普通文件夹");
        return candidates[i];
      } catch (error) { if (!Core.isMissingPathError(error)) throw error; }
    }
    throw new Error("工程文件夹当前无法访问，请检查磁盘连接");
  }
  return { inspectExistingMedia: inspectExistingMedia, nearestDirectory: nearestDirectory };
});
