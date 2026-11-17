# Verifying your download

Conduit is a program you download and run, so you should be able to check that the file
you have is the one this project built. Every release on the
[Releases page](https://github.com/raseley/conduit/releases):

- is built by **GitHub Actions** from the tagged source in this repository, never on a
  developer's machine;
- lists the **SHA-256 checksum** of each file in `SHA256SUMS.txt`, attached to the release;
- carries a **build provenance attestation**: a signed record, kept by GitHub, of which
  commit and which workflow produced each file;
- links to a **VirusTotal** scan of each file in its release notes.

The examples below use `Conduit-2026.11.0-setup.exe` (the installer); the portable version is
`Conduit-2026.11.0-portable.exe`. Use the file name and version you downloaded.

## Check the checksum

Download `SHA256SUMS.txt` from the same release into the same folder, then in PowerShell:

```powershell
Get-FileHash .\Conduit-2026.11.0-setup.exe -Algorithm SHA256
```

The `Hash` it prints must match the line for that file in `SHA256SUMS.txt` (PowerShell
prints it in upper case; the case does not matter). To compare them in one go:

```powershell
(Get-FileHash .\Conduit-2026.11.0-setup.exe -Algorithm SHA256).Hash -eq (Select-String -Path .\SHA256SUMS.txt -SimpleMatch 'Conduit-2026.11.0-setup.exe').Line.Split(' ')[0]
```

`True` means the file is exactly the one the release lists.

## Check the build provenance

With the [GitHub CLI](https://cli.github.com/) installed:

```powershell
gh attestation verify .\Conduit-2026.11.0-setup.exe --repo raseley/conduit
```

It succeeds only if GitHub holds an attestation for this exact file, produced by this
repository's release workflow, and it shows the commit the file was built from. A checksum
tells you the file was not changed after it was published; the attestation tells you
where it came from.

## Read the VirusTotal report

Each release's notes link to a VirusTotal report for each file. One or two detections
with generic or heuristic names (often from smaller engines) are a common false positive
for installers built with Electron, especially unsigned ones. Many detections, or
detections by the major antivirus engines, are not normal: don't run the file, and please
[report it](../SECURITY.md).

## Windows SmartScreen and the publisher name

Releases are not code-signed yet; signing is planned. Until then Windows may say "Windows
protected your PC" and show the publisher as "Unknown publisher". The checks above are the
way to confirm such a file. Once releases are signed, this section will name the publisher
to expect in the file's **Properties → Digital Signatures** tab and in any Windows prompt
that asks whether to run it.
