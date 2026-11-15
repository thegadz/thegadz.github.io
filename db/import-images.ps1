param(
  [string]$WorkbookPath = "",
  [string]$CatalogPath = "",
  [string]$ImageDir = "",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not $WorkbookPath) { $WorkbookPath = Join-Path $root "db\product-images.xlsx" }
if (-not $CatalogPath) { $CatalogPath = Join-Path $root "db\catalog.json" }
if (-not $ImageDir) { $ImageDir = Join-Path $root "assets\products" }

if (-not (Test-Path $WorkbookPath)) { throw "Workbook not found: $WorkbookPath. Run db\build-image-workbook.ps1 first." }

# ================================================================== read xlsx
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Read-XlsxFirstSheet([string]$path) {
  $zip = [System.IO.Compression.ZipFile]::OpenRead($path)
  try {
    $shared = @()
    $sstEntry = $zip.GetEntry("xl/sharedStrings.xml")
    if ($sstEntry) {
      $reader = New-Object System.IO.StreamReader($sstEntry.Open(), [System.Text.Encoding]::UTF8)
      $sstText = $reader.ReadToEnd()
      $reader.Close()
      [xml]$sst = $sstText
      foreach ($si in $sst.sst.si) {
        if ($si.t) { $shared += [string]$si.t.'#text' + [string]$si.t }
        elseif ($si.r) { $shared += ((@($si.r) | ForEach-Object { [string]$_.t }) -join "") }
        else { $shared += "" }
      }
    }

    $sheetEntry = $zip.GetEntry("xl/worksheets/sheet1.xml")
    if (-not $sheetEntry) { throw "sheet1.xml missing from $path" }
    $reader = New-Object System.IO.StreamReader($sheetEntry.Open(), [System.Text.Encoding]::UTF8)
    $sheetText = $reader.ReadToEnd()
    $reader.Close()
    [xml]$sheet = $sheetText

    $rows = New-Object System.Collections.Generic.List[hashtable]
    foreach ($row in @($sheet.worksheet.sheetData.row)) {
      if (-not $row) { continue }
      $cells = @{}
      foreach ($c in @($row.c)) {
        if (-not $c) { continue }
        $ref = [string]$c.r
        if ($ref -notmatch '^([A-Za-z]+)') { continue }
        $colNumber = 0
        foreach ($ch in $Matches[1].ToUpperInvariant().ToCharArray()) { $colNumber = $colNumber * 26 + ([int][char]$ch - 64) }
        $type = [string]$c.t
        $value = ""
        if ($type -eq "s") {
          $idx = 0
          if ([int]::TryParse([string]$c.v, [ref]$idx) -and $idx -ge 0 -and $idx -lt $shared.Count) { $value = $shared[$idx] }
        } elseif ($type -eq "inlineStr") {
          $value = [string]$c.is.t
        } else {
          $value = [string]$c.v
        }
        $cells[$colNumber] = $value
      }
      $rows.Add($cells)
    }
    return $rows
  } finally {
    $zip.Dispose()
  }
}

$sheetRows = Read-XlsxFirstSheet $WorkbookPath

$headerIndex = $null
$colMap = @{}
for ($i = 0; $i -lt $sheetRows.Count; $i++) {
  $cells = $sheetRows[$i]
  if ($cells[1] -eq "No") {
    $headerIndex = $i
    foreach ($key in $cells.Keys) { $colMap[[string]$cells[$key]] = [int]$key }
    break
  }
}
foreach ($required in @("slug", "Gambar (nama file)", "Status", "Sumber / Hak Pakai")) {
  if (-not $colMap.ContainsKey($required)) { throw "Column '$required' missing from the workbook header row. Rebuild with db\build-image-workbook.ps1." }
}

$entries = @{}
$order = New-Object System.Collections.Generic.List[string]
for ($i = $headerIndex + 1; $i -lt $sheetRows.Count; $i++) {
  $cells = $sheetRows[$i]
  $slug = ([string]$cells[$colMap["slug"]]).Trim()
  if (-not $slug) { continue }
  if ($entries.ContainsKey($slug)) { throw "Duplicate slug in workbook: $slug" }
  $entries[$slug] = [pscustomobject]@{
    Image  = ([string]$cells[$colMap["Gambar (nama file)"]]).Trim()
    Rights = ([string]$cells[$colMap["Sumber / Hak Pakai"]]).Trim()
    Status = ([string]$cells[$colMap["Status"]]).Trim()
  }
  $order.Add($slug)
}

if ($entries.Count -ne 73) { throw "Expected 73 product rows in the workbook, found $($entries.Count)" }

# ================================================================== validate
$allowedExt = @(".png", ".jpg", ".jpeg", ".webp")
$problems = @()
$warnings = @()
foreach ($slug in $order) {
  $entry = $entries[$slug]
  if (-not $entry.Image) { continue }
  if ($entry.Image -match '[\\/:*?"<>|]') { $problems += "${slug}: use a bare filename, no folders or illegal characters ($($entry.Image))"; continue }
  $ext = [System.IO.Path]::GetExtension($entry.Image).ToLowerInvariant()
  if ($allowedExt -notcontains $ext) { $problems += "${slug}: unsupported extension '$ext' (use .png .jpg .jpeg .webp)" }
  if ($entry.Image -ne $entry.Image.ToLowerInvariant()) { $warnings += "${slug}: filename should be lowercase ($($entry.Image))" }
  if ($entry.Status -ne "Sudah ada") { $warnings += "${slug}: image filled but Status is '$($entry.Status)'" }
  if (-not $entry.Rights) { $warnings += "${slug}: 'Sumber / Hak Pakai' is empty" }
  $filePath = Join-Path $ImageDir $entry.Image
  if (-not (Test-Path $filePath)) {
    $problems += "${slug}: file missing - assets\products\$($entry.Image)"
  } else {
    $sizeKb = [math]::Round((Get-Item $filePath).Length / 1KB)
    if ($sizeKb -gt 400) { $warnings += "${slug}: file is $sizeKb KB, aim for under 200 KB" }
  }
}

if ($problems.Count) {
  Write-Host "Import stopped. Fix these first:" -ForegroundColor Red
  foreach ($problem in $problems) { Write-Host "  - $problem" -ForegroundColor Red }
  exit 1
}
foreach ($warning in $warnings) { Write-Host "warning  $warning" -ForegroundColor Yellow }

# ================================================================== catalog
function ConvertTo-CatalogJsonString([string]$value) {
  # JSON string literal, escaping only what JSON needs. Keeps the file readable.
  $escaped = $value.Replace('\', '\\').Replace('"', '\"')
  $escaped = $escaped.Replace("`r", '\r').Replace("`n", '\n').Replace("`t", '\t')
  return '"' + $escaped + '"'
}

$text = [System.IO.File]::ReadAllText($CatalogPath, [System.Text.Encoding]::UTF8)
$catalog = $text | ConvertFrom-Json
$catalogSlugs = @{}
foreach ($product in $catalog.products) { $catalogSlugs[[string]$product.slug] = $true }
foreach ($slug in $order) {
  if (-not $catalogSlugs.ContainsKey($slug)) { throw "Workbook slug '$slug' is not in catalog.json. Never edit the slug column; rebuild the workbook instead." }
}

# Replace the image value of each product block in place, preserving formatting.
$filled = 0
$changed = 0
$missingBlocks = @()
foreach ($slug in $order) {
  $image = $entries[$slug].Image
  if ($image) { $filled++ }
  $literal = if ($image) { ConvertTo-CatalogJsonString $image } else { '""' }

  $slugLiteral = [regex]::Escape((ConvertTo-CatalogJsonString $slug))
  $pattern = '(?s)("slug": ' + $slugLiteral + '.*?)("image": )("(?:[^"\\]|\\.)*"|"")'
  $match = [regex]::Match($text, $pattern)
  if (-not $match.Success) {
    # Product has no image field yet: add one right after "color".
    $addPattern = '(?s)("slug": ' + $slugLiteral + '.*?)("color": "#[0-9a-fA-F]{6}")'
    $addMatch = [regex]::Match($text, $addPattern)
    if (-not $addMatch.Success) { $missingBlocks += $slug; continue }
    $replacement = $addMatch.Groups[1].Value + $addMatch.Groups[2].Value + ', "image": ' + $literal
    $text = $text.Substring(0, $addMatch.Index) + $replacement + $text.Substring($addMatch.Index + $addMatch.Length)
    $changed++
    continue
  }
  $current = $match.Groups[3].Value
  if ($current -ne $literal) {
    $replacement = $match.Groups[1].Value + $match.Groups[2].Value + $literal
    $text = $text.Substring(0, $match.Index) + $replacement + $text.Substring($match.Index + $match.Length)
    $changed++
  }
}

if ($missingBlocks.Count) { throw "Could not locate product blocks for: $($missingBlocks -join ', ')" }

# Validate before writing.
$null = $text | ConvertFrom-Json

Write-Host "Images assigned: $filled / $($order.Count)"
Write-Host "Blocks changed:  $changed"

if ($DryRun) {
  Write-Host "Dry run: catalog.json was not modified."
  exit 0
}

[System.IO.File]::WriteAllText($CatalogPath, $text, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Updated $CatalogPath"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  powershell -ExecutionPolicy Bypass -File db\build-seed.ps1"
Write-Host "  powershell -ExecutionPolicy Bypass -File workers\deploy-store.ps1"
