#requires -Version 5.1
<#
.SYNOPSIS
    One-shot setup + launch for the Conduit desktop (Electron) app.

.DESCRIPTION
    Walks a fresh checkout all the way to a running Electron app:

        1. Verifies prerequisites (Node >= 22.12) and finds a pnpm that actually
           runs: the one on PATH (activated through Corepack when Corepack is
           present), else the pinned version through npx. Node 25+ no longer
           bundles Corepack, and an upgrade can leave dead pnpm shims behind.
        2. Installs workspace dependencies (pnpm).
        3. Ensures the Electron runtime binary is actually downloaded
           (pnpm install no longer downloads it, so a fresh
           checkout has no electron.exe).
        4. Regenerates the protobuf code (pnpm gen:proto) - its output is
           gitignored and required by downstream packages.
        5. Builds every workspace package (pnpm -r build).
        6. Packages the shipped Windows .exe artifacts via electron-builder
           (NSIS installer + portable .exe) into apps/desktop/release.
        7. Launches the Electron app (apps/desktop) FROM SOURCE.

    Packaging produces the distributable .exe(s), but the app is still launched
    exactly as before - directly from the source build (electron.exe pointed at
    apps/desktop), NOT from the packaged artifact. Pass -SkipPackage to restore
    the original build-and-launch-only behavior.

    NO configuration is passed on the command line. On first launch the one-time
    bootstrap wizard gathers EVERYTHING - in the order you'd do it: create a
    Discord app and paste its Application ID, add a bot and paste its token,
    invite the bot and paste your Server ID, connect with Steam, then pair your
    Rust server in-game. Just run this script (or double-click the packaged
    .exe) and follow the wizard.

.PARAMETER SkipInstall
    Skip 'pnpm install' (use when dependencies are already installed).

.PARAMETER SkipBuild
    Skip proto generation and 'pnpm -r build' (use for a fast re-launch when
    the build is already current). Implies -SkipPackage.

.PARAMETER SkipPackage
    Skip the electron-builder packaging step (restores the original
    build-and-launch-from-source behavior without producing a .exe). Packaging
    is also skipped automatically when -SkipBuild is set.

.PARAMETER NoLaunch
    Run setup/build but do not launch Electron (useful for CI-style prep).

.EXAMPLE
    .\scripts\setup-and-launch.ps1

.EXAMPLE
    # Fast re-launch after the first successful run:
    .\scripts\setup-and-launch.ps1 -SkipInstall -SkipBuild
#>
[CmdletBinding()]
param(
    [switch]$SkipInstall,
    [switch]$SkipBuild,
    [switch]$SkipPackage,
    [switch]$NoLaunch
)

# Fail fast: surface the first error instead of limping forward.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# --- pretty output helpers ---------------------------------------------------
function Write-Step  { param([string]$Message) Write-Host "`n=== $Message ===" -ForegroundColor Cyan }
function Write-Info  { param([string]$Message) Write-Host "    $Message" -ForegroundColor Gray }
function Write-Ok    { param([string]$Message) Write-Host "  + $Message" -ForegroundColor Green }
function Write-Warn  { param([string]$Message) Write-Host "  ! $Message" -ForegroundColor Yellow }

# Run a native command and throw with context if it returns non-zero.
function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$Exe,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [string]$What = ""
    )
    $label = if ($What) { $What } else { "$Exe $($Arguments -join ' ')" }
    Write-Info "> $Exe $($Arguments -join ' ')"
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$label failed (exit code $LASTEXITCODE)."
    }
}

# How pnpm is invoked for this run: plain 'pnpm', or 'npx --yes pnpm@<pinned>'
# when no working pnpm is on PATH. Set once in the prerequisites step.
$script:PnpmExe = "pnpm"
$script:PnpmPrefix = @()

# Run a pnpm command through whichever invocation the prerequisites step chose.
function Invoke-Pnpm {
    param(
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [string]$What = ""
    )
    Invoke-Checked -Exe $script:PnpmExe -Arguments (@($script:PnpmPrefix) + $Arguments) -What $What
}

# Run '<exe> <args> --version' and return the version, or $null if the command
# does not actually run. Finding a command on PATH is not enough: after an
# upgrade to Node 25+ (which dropped the bundled Corepack) the old Corepack
# 'pnpm' shims stay in the Node folder and fail with MODULE_NOT_FOUND.
function Get-ToolVersion {
    param(
        [Parameter(Mandatory = $true)][string]$Exe,
        [string[]]$Arguments = @()
    )
    if (-not (Get-Command $Exe -ErrorAction SilentlyContinue)) { return $null }
    # A broken shim writes to stderr; under 'Stop' that would throw in Windows
    # PowerShell before we could read the exit code.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $allArgs = @($Arguments) + @("--version")
        $out = & $Exe @allArgs 2>$null
        if ($LASTEXITCODE -eq 0 -and $out) { return "$(@($out)[-1])".Trim() }
    } catch {
        # Fall through: the tool is unusable.
    } finally {
        $ErrorActionPreference = $previous
    }
    return $null
}

# Resolve electron.exe from path.txt (electron's own marker), falling back to
# the conventional dist\electron.exe. Returns $null when not yet provisioned.
function Resolve-ElectronExe {
    param([string]$Dir)
    $pt = Join-Path $Dir "path.txt"
    if (Test-Path $pt) {
        $rel = (Get-Content $pt -Raw).Trim()
        if ($rel) {
            $cand = Join-Path $Dir $rel
            if (Test-Path $cand) { return $cand }
        }
    }
    $cand = Join-Path $Dir "dist\electron.exe"
    if (Test-Path $cand) { return $cand }
    return $null
}

# --- locate the repo root (script lives in <repo>/scripts) -------------------
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Split-Path -Parent $ScriptDir
$DesktopDir = Join-Path $RepoRoot "apps\desktop"

if (-not (Test-Path (Join-Path $RepoRoot "pnpm-workspace.yaml"))) {
    throw "Could not find pnpm-workspace.yaml at '$RepoRoot'. Run this script from inside the Conduit checkout."
}
if (-not (Test-Path $DesktopDir)) {
    throw "Desktop app not found at '$DesktopDir'."
}

Write-Step "Conduit setup"
Write-Info "Repo root : $RepoRoot"

Push-Location $RepoRoot
try {
    # --- 1. prerequisites ----------------------------------------------------
    Write-Step "Checking prerequisites"

    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        throw "Node.js is not on PATH. Install Node 22.12+ from https://nodejs.org and re-run."
    }
    $nodeVersion = (& node --version).TrimStart('v')
    $nodeMajor = [int]($nodeVersion.Split('.')[0])
    $nodeMinor = [int]($nodeVersion.Split('.')[1])
    if ($nodeMajor -lt 22 -or ($nodeMajor -eq 22 -and $nodeMinor -lt 12)) {
        throw "Node 22.12+ required (found v$nodeVersion). Upgrade from https://nodejs.org."
    }
    Write-Ok "Node v$nodeVersion"

    # The pnpm version this repo pins (package.json "packageManager").
    $pinnedPnpm = "pnpm@9.15.9"
    try {
        $pm = (Get-Content (Join-Path $RepoRoot "package.json") -Raw | ConvertFrom-Json).packageManager
        if ($pm -match '^pnpm@[0-9A-Za-z.\-]+') { $pinnedPnpm = $Matches[0] }
    } catch {
        Write-Warn "Could not read packageManager from package.json; assuming $pinnedPnpm."
    }

    # Prefer Corepack, when it exists, so the pinned pnpm version is used.
    # (Bundled with Node 20-24; a separate 'npm install -g corepack' on 25+.)
    if (Get-Command corepack -ErrorAction SilentlyContinue) {
        try {
            & corepack enable 2>$null | Out-Null
            & corepack prepare $pinnedPnpm --activate 2>$null | Out-Null
        } catch {
            Write-Warn "corepack prepare failed; falling back to whatever pnpm is on PATH."
        }
    }

    # Use the pnpm on PATH only if it really runs; otherwise run the pinned
    # version through npx, which needs nothing installed globally.
    $pnpmVersion = Get-ToolVersion -Exe "pnpm"
    if ($pnpmVersion) {
        Write-Ok "pnpm v$pnpmVersion"
    } else {
        $stale = Get-Command pnpm -ErrorAction SilentlyContinue
        if ($stale) {
            Write-Warn "'pnpm' is on PATH ($($stale.Source)) but does not run."
            Write-Warn "This is usually a Corepack shim left behind by an upgrade to Node 25+,"
            Write-Warn "which no longer bundles Corepack. To repair it for good, delete the"
            Write-Warn "pnpm*/pnpx*/yarn* files in that folder from an elevated prompt, then run:"
            Write-Warn "    npm install -g corepack; corepack enable; corepack prepare $pinnedPnpm --activate"
        } else {
            Write-Warn "pnpm is not installed (Node 25+ no longer bundles Corepack)."
        }
        $npxArgs = @("--yes", $pinnedPnpm)
        $pnpmVersion = Get-ToolVersion -Exe "npx" -Arguments $npxArgs
        if (-not $pnpmVersion) {
            throw "No working pnpm found, and 'npx --yes $pinnedPnpm' did not run either. Install pnpm 9.x (https://pnpm.io/installation) and re-run."
        }
        $script:PnpmExe = "npx"
        $script:PnpmPrefix = $npxArgs
        Write-Ok "pnpm v$pnpmVersion (via 'npx --yes $pinnedPnpm' for this run)"
    }

    # --- 2. install dependencies ---------------------------------------------
    if ($SkipInstall) {
        Write-Step "Installing dependencies (skipped)"
    } else {
        Write-Step "Installing dependencies"
        Invoke-Pnpm -Arguments @("install") -What "pnpm install"
        Write-Ok "Dependencies installed"
    }

    # --- 3. ensure the Electron runtime binary is present --------------------
    # 'electron' is a devDependency of @conduit/desktop. Since Electron 42 its
    # postinstall no longer downloads the binary, which leaves node_modules/electron
    # without an electron.exe. We must provision the real runtime before we can launch.
    Write-Step "Ensuring Electron runtime binary"
    $electronPkg = Join-Path $DesktopDir "node_modules\electron"
    if (-not (Test-Path $electronPkg)) {
        throw "Electron package missing at '$electronPkg'. Did 'pnpm install' run? Re-run without -SkipInstall."
    }

    # pnpm symlinks node_modules/electron into the content-addressable store; the
    # real install.js / dist / path.txt live in the link target. Resolve it so we
    # download + extract into the actual files (writing through the link also works
    # on Windows, but resolving keeps paths unambiguous in messages).
    $electronDir = $electronPkg
    $linkTarget = (Get-Item $electronPkg).Target
    if ($linkTarget) { $electronDir = @($linkTarget)[0] }

    $electronExe = Resolve-ElectronExe -Dir $electronDir

    if (-not $electronExe) {
        Write-Info "Electron binary not found; provisioning (downloads ~100 MB on first run)..."
        # Step 1: run electron's own installer. It downloads the matching build to
        # the @electron/get cache and extracts it. Clear the skip flag for this
        # call only so the download actually happens.
        $prevSkip = $env:ELECTRON_SKIP_BINARY_DOWNLOAD
        Remove-Item Env:\ELECTRON_SKIP_BINARY_DOWNLOAD -ErrorAction SilentlyContinue
        try {
            Push-Location $electronDir
            try { & node install.js } catch { Write-Warn "electron install.js threw: $($_.Exception.Message)" }
        } finally {
            Pop-Location
            if ($null -ne $prevSkip) { $env:ELECTRON_SKIP_BINARY_DOWNLOAD = $prevSkip }
        }
        $electronExe = Resolve-ElectronExe -Dir $electronDir
    }

    if (-not $electronExe) {
        # Step 2 (fallback): install.js fully populates the @electron/get cache but
        # can under-extract its own dist in some sandboxed environments (exits 0
        # after a single file). Extract the cached zip ourselves - deterministic
        # and toolchain-free.
        Write-Info "Extraction incomplete; extracting cached Electron zip directly..."
        $version = (Get-Content (Join-Path $electronDir "package.json") -Raw | ConvertFrom-Json).version
        $arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "ia32" }
        if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { $arch = "arm64" }
        $zipName = "electron-v$version-win32-$arch.zip"

        $cacheRoots = @(
            $env:electron_config_cache,
            $env:ELECTRON_CACHE,
            (Join-Path $env:LOCALAPPDATA "electron\Cache")
        ) | Where-Object { $_ -and (Test-Path $_) }

        $zip = $null
        foreach ($root in $cacheRoots) {
            $hit = Get-ChildItem -Path $root -Recurse -Filter $zipName -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($hit) { $zip = $hit.FullName; break }
        }
        if (-not $zip) {
            throw "Could not provision Electron $version ($zipName). Installer did not extract and no cached zip was found. Check network access to github.com/electron/electron releases, then re-run."
        }

        $dist = Join-Path $electronDir "dist"
        Remove-Item $dist -Recurse -Force -ErrorAction SilentlyContinue
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $dist)
        # electron's loader (cli.js) reads path.txt to find the executable.
        Set-Content -Path (Join-Path $electronDir "path.txt") -Value "electron.exe" -NoNewline
        $electronExe = Resolve-ElectronExe -Dir $electronDir
    }

    if (-not $electronExe) {
        throw "Failed to provision the Electron runtime binary under '$electronDir'."
    }
    Write-Ok "Electron runtime ready: $electronExe"

    # --- 4 + 5. generate proto + build ---------------------------------------
    if ($SkipBuild) {
        Write-Step "Building workspace (skipped)"
    } else {
        Write-Step "Generating protobuf code"
        # rustplus-proto's generated output is gitignored; regenerate before build.
        Invoke-Pnpm -Arguments @("gen:proto") -What "pnpm gen:proto"
        Write-Ok "Protobuf code generated"

        Write-Step "Building all packages"
        # Build before launch: downstream packages resolve @conduit/rustplus-proto
        # via its package exports -> dist/, which is only complete after build.
        Invoke-Pnpm -Arguments @("-r", "build") -What "pnpm -r build"
        Write-Ok "Build complete"
    }

    # Sanity-check the compiled entry point exists before launching.
    $mainEntry = Join-Path $DesktopDir "dist\main.js"
    if (-not (Test-Path $mainEntry)) {
        throw "Build output missing ($mainEntry). Re-run without -SkipBuild."
    }

    # --- 6. package the shipped .exe (electron-builder) ----------------------
    # Produce the distributable Windows artifacts (NSIS installer + portable
    # .exe) from the build we just made, into apps/desktop/release. This does
    # NOT change how we launch below: we still run the app from source
    # (electron.exe -> apps/desktop), not from the packaged artifact.
    # electron-builder is a devDependency of @conduit/desktop; invoke it
    # directly via 'pnpm exec' (rather than the package's 'dist' script) so we
    # reuse the build above instead of recompiling.
    if ($SkipBuild -or $SkipPackage) {
        Write-Step "Packaging .exe (skipped)"
    } else {
        Write-Step "Packaging Windows .exe (electron-builder)"
        Write-Info "First run also downloads electron-builder's own toolchain."
        Invoke-Pnpm `
            -Arguments @("--filter", "@conduit/desktop", "exec", "electron-builder", "--config", "electron-builder.yml") `
            -What "electron-builder packaging"

        $releaseDir = Join-Path $DesktopDir "release"
        $artifacts = @(Get-ChildItem -Path $releaseDir -Filter *.exe -ErrorAction SilentlyContinue)
        if ($artifacts.Count -gt 0) {
            Write-Ok "Packaged $($artifacts.Count) .exe artifact(s) into $releaseDir"
            foreach ($a in $artifacts) { Write-Info "  $($a.Name)" }
        } else {
            Write-Warn "electron-builder reported success but no .exe was found under $releaseDir."
        }
    }

    # --- 7. launch -----------------------------------------------------------
    if ($NoLaunch) {
        Write-Step "Launch (skipped)"
        Write-Ok "Setup complete. Launch later with:"
        Write-Info "& '$electronExe' '$DesktopDir'"
        return
    }

    Write-Step "Launching Conduit (Electron)"
    Write-Info "First run shows the bootstrap wizard (gathers everything - no CLI args):"
    Write-Info "  1) Create the Discord bot (token)   2) Enable intents   3) Invite the bot"
    Write-Info "  4) Connect with Steam   5) Pair your server   6) Finish in Discord"
    Write-Host ""

    # Launch the verified runtime directly, pointing it at the desktop app dir so
    # Electron loads its 'main' (dist/main.js). Conduit is a headless tray app:
    # once started it detaches and keeps running in the system tray, so the script
    # returns here rather than blocking.
    $proc = Start-Process -FilePath $electronExe -ArgumentList @($DesktopDir) -PassThru
    Write-Ok "Conduit launched (PID $($proc.Id)). It now lives in the system tray."
    Write-Info "Finish setup in the wizard window, then control everything from Discord."
    Write-Info "Quit via the tray icon's menu when you're done."
}
finally {
    Pop-Location
}
