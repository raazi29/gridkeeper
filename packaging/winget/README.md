# winget manifests (staged, not yet submitted)

`manifests/r/raazi29/Gridkeeper/<version>/` holds the three files of a winget multi-file manifest
(version, installer, defaultLocale; schema 1.28.0) with the same folder layout as
[microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs). Nothing here is published until a maintainer opens a
pull request to winget-pkgs; once that PR is merged, users install with:

```powershell
winget install raazi29.Gridkeeper
```

The installer is Tauri's NSIS setup in per-user mode (`InstallerType: nullsoft`, `Scope: user`): it installs to
`%LOCALAPPDATA%\Gridkeeper` without elevation and is installed silently with `/S`.

References: [manifest format](https://learn.microsoft.com/windows/package-manager/package/manifest),
[submitting to winget-pkgs](https://learn.microsoft.com/windows/package-manager/package/repository),
[schemas](https://github.com/microsoft/winget-cli/tree/master/schemas/JSON/manifests),
[wingetcreate submit](https://github.com/microsoft/winget-create/blob/main/doc/submit.md) /
[update](https://github.com/microsoft/winget-create/blob/main/doc/update.md).

## Submitting a release

1. Publish the GitHub release with `Gridkeeper_<version>_x64-setup.exe` attached.
2. Fill in the hashes (writes `manifests/r/raazi29/Gridkeeper/<version>/`, copied from the previous version folder),
   check the diff and commit it:

   ```powershell
   node scripts/release/update-manifests.mjs <version>
   ```

   The committed files must not contain an all-zero `InstallerSha256`; that is the placeholder from before the
   release existed.
3. Validate:

   ```powershell
   winget validate --manifest packaging/winget/manifests/r/raazi29/Gridkeeper/<version>
   ```

4. Optional install test, in Windows Sandbox or a VM (not on a machine running Gridkeeper you care about):

   ```powershell
   winget settings --enable LocalManifestFiles     # once, from an elevated shell
   winget install --manifest packaging/winget/manifests/r/raazi29/Gridkeeper/<version>
   ```

5. Submit, either way:
   - **wingetcreate** (`winget install Microsoft.WingetCreate`; a GitHub token with `public_repo` scope, see
     <https://aka.ms/winget-create-token>):

     ```powershell
     wingetcreate submit --prtitle "New package: raazi29.Gridkeeper version <version>" packaging/winget/manifests/r/raazi29/Gridkeeper/<version>
     ```

     Without `--token` it asks for a GitHub login. For later versions use
     `"New version: raazi29.Gridkeeper version <version>"` as the title.
   - **Manual PR:** fork microsoft/winget-pkgs, copy the folder to `manifests/r/raazi29/Gridkeeper/<version>/` in the
     fork, open a pull request and fill in the checklist from the PR template.

6. The winget-pkgs bots validate the manifest, install it in a VM and scan the installer. The first submission of a
   new package usually also gets a manual review; answer review comments on the PR.

Once the package exists in winget-pkgs, a later version can also be submitted without these files:
`wingetcreate update raazi29.Gridkeeper --version <version> --urls https://github.com/raazi29/gridkeeper/releases/download/v<version>/Gridkeeper_<version>_x64-setup.exe --submit`.
Keep the staged folder in sync anyway, since `update-manifests.mjs` copies the next version from it.
