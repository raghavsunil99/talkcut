// Windows builds made on a Mac can't run rcedit (it needs Wine), so the app's icon and
// file details are written into the .exe here, before the installer is made.
const fs = require('node:fs');
const path = require('node:path');

// Mac: without an Apple developer certificate the app gets an ad-hoc signature, so Apple
// silicon Macs accept the bundle (otherwise they call it "damaged").
function adhocSignMac(context) {
  const { execFileSync } = require('node:child_process');
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  console.log(`  • ad-hoc signed  app=${app}`);
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName === 'darwin') { adhocSignMac(context); return; }
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
    FileDescription: 'Talkcut by Raghav', ProductName: 'Talkcut by Raghav', CompanyName: 'Raghav', InternalName: 'Talkcut',
    OriginalFilename: `${context.packager.appInfo.productFilename}.exe`, LegalCopyright: 'Built by Raghav', FileVersion: version, ProductVersion: version,
  };
  for (const lang2 of info.getAllLanguagesForStringValues()) info.setStringValues(lang2, strings);
  info.setFileVersion(a, b, c, 0);
  info.setProductVersion(a, b, c, 0);
  info.outputToResourceEntries(res.entries);

  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
  console.log(`  • set Talkcut icon and details  file=${exePath}`);
};
