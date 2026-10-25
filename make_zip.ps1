$deploy = "c:\Users\ThinKpad\Downloads\Ritmada Gemini 3.8 (Jailbreak)\tiksave-heroku"
$zip = "c:\Users\ThinKpad\Downloads\Ritmada Gemini 3.8 (Jailbreak)\tiksave-heroku.zip"

# Install deps
Set-Location $deploy
Write-Host "Installing dependencies..."
& npm install --omit=dev 2>&1
Write-Host "Deps installed."

# Remove old zip
if (Test-Path $zip) { Remove-Item $zip -Force }

# Create zip — exclude node_modules (Heroku builds them), downloads, bin
Write-Host "Creating zip..."
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zipStream = [System.IO.Compression.ZipFile]::Open($zip, 'Create')

Get-ChildItem -Recurse -File $deploy | Where-Object {
    $rel = $_.FullName.Substring($deploy.Length + 1)
    # exclude node_modules, downloads, bin, logs
    $rel -notmatch '^(node_modules|downloads|bin)[\\/]' -and
    $rel -notmatch '\.log$'
} | ForEach-Object {
    $rel = $_.FullName.Substring($deploy.Length + 1)
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $zipStream, $_.FullName, $rel, 'Optimal'
    ) | Out-Null
    Write-Host "  + $rel"
}

$zipStream.Dispose()
$size = [math]::Round((Get-Item $zip).Length / 1KB, 1)
Write-Host ""
Write-Host "ZIP READY: $zip ($size KB)"
