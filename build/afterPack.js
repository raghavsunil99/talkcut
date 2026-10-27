// Windows builds made on a Mac can't run rcedit (it needs Wine), so the app's icon and
// file details are written into Cutline.exe here, before the installer is made.
const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const { NtExecutable, NtExecutableResource, Resource, Data } = await import('resedit');
  const exePath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  const exe = NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const res = NtExecutableResource.from(exe);

  const icon = Data.IconFile.from(fs.readFileSync(path.join(__dirname, 'icon.ico')));
  const groups = Resource.IconGroupEntry.fromEntries(res.entries);
  const groupId = groups[0]?.id ?? 1;
  const lang = groups[0]?.lang ?? 1033;
  Resource.IconGroupEntry.replaceIconsForResource(res.entries, groupId, lang, icon.icons.map((i) => i.data));

  const version = context.packager.appInfo.version;
  const [a, b, c] = version.split('.').map(Number);
  const info = Resource.VersionInfo.fromEntries(res.entries)[0];
  const strings = {
    FileDescription: 'Cutline by Raghav', ProductName: 'Cutline by Raghav', CompanyName: 'Raghav', InternalName: 'Cutline',
    OriginalFilename: `${context.packager.appInfo.productFilename}.exe`, LegalCopyright: 'Built by Raghav', FileVersion: version, ProductVersion: version,
  };
  for (const lang2 of info.getAllLanguagesForStringValues()) info.setStringValues(lang2, strings);
  info.setFileVersion(a, b, c, 0);
  info.setProductVersion(a, b, c, 0);
  info.outputToResourceEntries(res.entries);

  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
  console.log(`  • set Cutline icon and details  file=${exePath}`);
};
