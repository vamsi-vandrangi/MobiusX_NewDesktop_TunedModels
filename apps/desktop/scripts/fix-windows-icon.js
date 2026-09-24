// electron-builder's Windows icon embedding is broken on this project's
// (non-Windows) Linux build host: it writes a corrupted RT_GROUP_ICON
// resource directory into the packaged app's main .exe -- the declared
// per-frame sizes don't match the real ICO frame data (verified with
// `wrestool -x -t14 MobiusX.ai.exe`, e.g. 256x256 declared as 8232 bytes
// when the real BMP/DIB frame is 270376 bytes). Windows silently falls
// back to Electron's stock icon when it can't parse the corrupted group,
// which is exactly the "shows the Electron logo instead of the MobiusX
// logo" bug reported after installing on Windows (2026-09-24). The NSIS
// installer wrapper's own icon is unaffected -- only the *installed*
// app's exe. assets/icon.ico itself is a well-formed ICO (verified byte
// for byte); the corruption is introduced by electron-builder's icon
// embedding step on this host, not by the source asset.
//
// Fix: re-embed the icon after packaging using `resedit` (a pure-JS PE
// resource editor -- no Wine/rcedit involved), which writes a correct,
// internally-consistent RT_GROUP_ICON directory.
const fs = require("fs");
const path = require("path");
const PELibrary = require("pe-library");
const ResEdit = require("resedit");

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== "win32") return;

  const exePath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.exe`
  );
  const iconPath = path.join(__dirname, "..", "assets", "icon.ico");

  if (!fs.existsSync(exePath)) {
    console.warn(`[fix-windows-icon] ${exePath} not found -- skipping`);
    return;
  }

  const exe = PELibrary.NtExecutable.from(fs.readFileSync(exePath));
  const res = PELibrary.NtExecutableResource.from(exe);

  const groupIds = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries).map(
    (entry) => entry.id
  );
  if (groupIds.length === 0) {
    console.warn(`[fix-windows-icon] no icon group resource found in ${exePath} -- skipping`);
    return;
  }

  const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(iconPath));

  for (const id of groupIds) {
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
      res.entries,
      id,
      1033, // lang: en-US
      iconFile.icons.map((item) => item.data)
    );
  }

  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
  console.log(
    `[fix-windows-icon] re-embedded ${iconPath} into ${exePath} (icon group id(s): ${groupIds.join(", ")})`
  );
};
