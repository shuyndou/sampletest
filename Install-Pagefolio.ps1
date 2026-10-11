$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms

$root = $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $root 'windows-package\manifest.json') -Raw | ConvertFrom-Json
$oneDriveRoot = $env:OneDrive
if ([string]::IsNullOrWhiteSpace($oneDriveRoot)) {
    $oneDriveRoot = Join-Path $env:USERPROFILE 'OneDrive'
}
$defaultPath = Join-Path $oneDriveRoot '仕事\開発\Pagefolio'
$answer = [System.Windows.Forms.MessageBox]::Show(
    "保存先: $defaultPath`r`n`r`nこの場所に保存しますか？`r`n「いいえ」で別のフォルダーを選べます。",
    'Pagefolio', 'YesNoCancel', 'Question')
if ($answer -eq 'Cancel') { exit 0 }
$destination = $defaultPath
if ($answer -eq 'No') {
    $picker = New-Object System.Windows.Forms.FolderBrowserDialog
    $picker.Description = 'Pagefolioの保存先を選んでください。'
    $picker.ShowNewFolderButton = $true
    if ($picker.ShowDialog() -ne 'OK') { $picker.Dispose(); exit 0 }
    $destination = $picker.SelectedPath
    $picker.Dispose()
}

# Preserve all existing files. Use a new child directory when the chosen folder is not empty.
if ((Test-Path -LiteralPath $destination) -and (Get-ChildItem -LiteralPath $destination -Force | Select-Object -First 1)) {
    $destination = Join-Path $destination ('Pagefolio-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 6))
}

$tempZip = Join-Path ([IO.Path]::GetTempPath()) ('Pagefolio-' + [Guid]::NewGuid().ToString('N') + '.zip')
try {
    Write-Host 'Reassembling application package...'
    $output = [IO.File]::Open($tempZip, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
    try {
        foreach ($part in $manifest.parts) {
            $partPath = Join-Path $root ('windows-package\' + $part.name)
            if ((Get-Item -LiteralPath $partPath).Length -ne $part.size) { throw "Incomplete download: $($part.name)" }
            $inputFile = [IO.File]::OpenRead($partPath)
            try { $inputFile.CopyTo($output) } finally { $inputFile.Dispose() }
        }
    } finally { $output.Dispose() }
    Write-Host 'Verifying SHA-256...'
    $actual = (Get-FileHash -LiteralPath $tempZip -Algorithm SHA256).Hash
    if ($actual -ne $manifest.sha256) { throw 'Package verification failed. Please download the repository ZIP again.' }
    Write-Host "Installing to: $destination"
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    Expand-Archive -LiteralPath $tempZip -DestinationPath $destination
    $exe = Join-Path $destination 'Pagefolio.exe'
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Pagefolio.exe was not found after extraction.' }
    Write-Host "Installed: $exe"
    [System.Windows.Forms.MessageBox]::Show("保存が完了しました。`r`n$destination`r`n`r`nPagefolioを起動します。", 'Pagefolio', 'OK', 'Information') | Out-Null
    Start-Process -FilePath $exe -WorkingDirectory $destination
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Pagefolio - Error', 'OK', 'Error') | Out-Null
    exit 1
} finally {
    if (Test-Path -LiteralPath $tempZip) { Remove-Item -LiteralPath $tempZip -Force }
}
