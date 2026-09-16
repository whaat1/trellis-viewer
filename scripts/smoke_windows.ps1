$ErrorActionPreference = 'Stop'
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$artifact = Join-Path $PWD "release/$version/Trellis-Viewer_${version}_x64-setup.exe"
$installDir = Join-Path $env:RUNNER_TEMP 'trellis-viewer-smoke'
if (Test-Path $installDir) { throw "Smoke install directory already exists: $installDir" }
$fixture = (Resolve-Path 'examples/sample-project').Path
function SourceHashes {
    return (Get-ChildItem -LiteralPath $fixture -File -Recurse -Force | Sort-Object FullName |
        ForEach-Object { "$($_.FullName):$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash)" }) -join "`n"
}
$before = SourceHashes
$process = $null
try {
    $installer = Start-Process -FilePath $artifact -ArgumentList '/S', "/D=$installDir" -PassThru -Wait
    if ($installer.ExitCode -ne 0) { throw "Installer exited with $($installer.ExitCode)" }
    $binary = Join-Path $installDir 'trellis-viewer.exe'
    if (!(Test-Path $binary)) { throw 'Installed application executable missing' }
    foreach ($notice in @('LICENSE', 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES_WINDOWS.md')) {
        if (!(Get-ChildItem -LiteralPath $installDir -Filter $notice -Recurse)) { throw "Missing $notice" }
    }
    $env:TRELLIS_PERF_PROJECTS = ConvertTo-Json -InputObject @($fixture) -Compress
    $process = Start-Process -FilePath $binary -PassThru
    $deadline = (Get-Date).AddSeconds(60)
    do {
        Start-Sleep -Milliseconds 500
        $process.Refresh()
        if ($process.HasExited) { throw "Application exited during startup: $($process.ExitCode)" }
    } until ($process.MainWindowHandle -ne 0 -or (Get-Date) -gt $deadline)
    if ($process.MainWindowHandle -eq 0) { throw 'Application window did not appear' }
    Start-Sleep -Seconds 5
    $process.Refresh()
    if ($process.HasExited) { throw 'Application closed after showing its window' }
    $title = $process.MainWindowTitle
    if ($title -notlike '*Trellis Viewer*') { throw "Unexpected window title: $title" }
    $null = $process.CloseMainWindow()
    if (!$process.WaitForExit(15000)) { throw 'Application did not close normally' }
    if ((SourceHashes) -ne $before) { throw 'Imported source files changed' }
    $uninstaller = Join-Path $installDir 'uninstall.exe'
    if (!(Test-Path $uninstaller)) { throw 'Uninstaller missing' }
    $uninstall = Start-Process -FilePath $uninstaller -ArgumentList '/S' -PassThru -Wait
    if ($uninstall.ExitCode -ne 0) { throw "Uninstaller exited with $($uninstall.ExitCode)" }
    $deadline = (Get-Date).AddSeconds(20)
    while ((Test-Path $binary) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
    if (Test-Path $binary) { throw 'Application remains after uninstall' }
    @{
        version = $version; commit = $env:GITHUB_SHA; os = [Environment]::OSVersion.VersionString
        installed = $true; windowTitle = $title; launched = $true; closedNormally = $true
        sourceUnchanged = $true; uninstalled = $true
        limitation = 'Windows Server 2022 automated install/window/exit smoke; not a full Windows 11 interactive UI test.'
    } | ConvertTo-Json | Set-Content -Encoding utf8 "release/$version/windows-smoke.json"
} finally {
    if ($process -and !$process.HasExited) { Stop-Process -Id $process.Id -ErrorAction SilentlyContinue }
    Remove-Item Env:TRELLIS_PERF_PROJECTS -ErrorAction SilentlyContinue
}
