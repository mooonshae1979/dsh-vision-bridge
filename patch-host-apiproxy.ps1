<#
.SYNOPSIS
  dsh-multimodal: patch / restore the host image-admission check.

.DESCRIPTION
  The host (@deepseek-ai/dsh-host-apiproxy inside the npm-global @deepseek-ai/dsh
  bundle) rejects a message that carries images when the selected model does not
  declare image input. dsh-multimodal instead wants those messages admitted and
  routes the images to a vision-capable subagent at agent/pre-step.

  This script adds a RELAX_IMAGE_ADMISSION switch (default true) in front of the
  two admission checks (session prompt + session selectModel). Run it again after
  every `npm update -g @deepseek-ai/dsh` or dsh reinstall — the stock file is
  restored by the update, and the script is idempotent.

.PARAMETER Revert
  Restore the stock (unpatched) file from the backup created at apply time.

.EXAMPLE
  pwsh -File patch-host-apiproxy.ps1          # apply the relax patch
  pwsh -File patch-host-apiproxy.ps1 -Revert  # restore stock behavior
#>
param(
  [switch]$Revert
)
$ErrorActionPreference = 'Stop'

function Find-HostFile {
  $roots = @(
    (Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-host-apiproxy'),
    (Join-Path $env:USERPROFILE 'AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-host-apiproxy'),
    (Join-Path $env:LOCALAPPDATA 'npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-host-apiproxy')
  )
  foreach ($root in $roots) {
    $file = Join-Path $root 'lib\index.js'
    if (Test-Path $file) { return $file }
  }
  throw "dsh-host-apiproxy lib/index.js not found. Checked: $($roots | ForEach-Object { Join-Path $_ 'lib\index.js' } | Out-String)"
}

$file = Find-HostFile
$backup = "$file.bak-dsh-multimodal"
$relaxConst = @'
/**
 * dsh-multimodal patch: relax host image admission.
 * When true, a message carrying images is admitted even when the selected
 * model does not declare image input — the dsh-multimodal plugin's
 * agent/pre-step handler routes the images to a vision-capable subagent
 * instead of rejecting the message. Set to false to restore stock behavior.
 */
const RELAX_IMAGE_ADMISSION = true;
'@

function Assert-Contains([string]$Content, [string]$Needle, [string]$What) {
  if (-not $Content.Contains($Needle)) {
    throw "patch target missing ($What) in $file — the installed dsh version may differ; check the file manually."
  }
}

if ($Revert) {
  if (-not (Test-Path $backup)) { throw "no backup at $backup — nothing to revert." }
  Copy-Item $backup $file -Force
  Write-Host "restored stock host-apiproxy from $backup" -ForegroundColor Green
  exit 0
}

$content = Get-Content $file -Raw -Encoding UTF8

# Already patched?
if ($content.Contains('RELAX_IMAGE_ADMISSION')) {
  Write-Host "host-apiproxy already patched (RELAX_IMAGE_ADMISSION present); nothing to do." -ForegroundColor Yellow
  exit 0
}

# 1) relax switch constant after the last top import line.
$anchor1 = 'import { runNativeCommand } from "@deepseek-ai/dsh-native-command";'
Assert-Contains $content $anchor1 'top import anchor'
$content = $content.Replace($anchor1, $anchor1 + "`n" + $relaxConst)

# 2) session prompt admission (modelInfo) and 3) session selectModel admission (info).
$promptCheck = 'if (modelInfo.inputModalities !== void 0 && !modelInfo.inputModalities.includes("image")) return err(request, {'
Assert-Contains $content $promptCheck 'prompt image admission'
$content = $content.Replace($promptCheck, 'if (RELAX_IMAGE_ADMISSION !== true && ' + $promptCheck.Substring(3))

$selectCheck = 'if (info.inputModalities !== void 0 && !info.inputModalities.includes("image")) return err(request, {'
Assert-Contains $content $selectCheck 'selectModel image admission'
$content = $content.Replace($selectCheck, 'if (RELAX_IMAGE_ADMISSION !== true && ' + $selectCheck.Substring(3))

# Backup the stock file once, then write.
if (-not (Test-Path $backup)) {
  Copy-Item $file $backup
  Write-Host "backed up stock file to $backup" -ForegroundColor Cyan
}
Set-Content $file $content -NoNewline -Encoding UTF8
Write-Host "patched $file (RELAX_IMAGE_ADMISSION = true)." -ForegroundColor Green
Write-Host "restart 'dsh web' for the change to take effect. After a dsh upgrade, re-run this script."
