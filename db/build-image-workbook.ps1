param(
  [string]$OutPath = "D:\DATA\project\gadzstore\db\product-images.xlsx"
)

$ErrorActionPreference = "Stop"

# Build a minimal, valid .xlsx (SpreadsheetML in a zip) with two sheets:
#   1. "Gambar Produk"  - the data grid the user fills in
#   2. "Cara Pakai"     - instructions
# No Excel/COM needed. Excel, LibreOffice and Google Sheets all open this.

function Esc([string]$s) {
  if ($null -eq $s) { return "" }
  $s = $s -replace '&', '&amp;'
  $s = $s -replace '<', '&lt;'
  $s = $s -replace '>', '&gt;'
  $s = $s -replace '"', '&quot;'
  return $s
}

function Col([int]$index) {
  # 1 -> A, 27 -> AA
  $name = ""
  while ($index -gt 0) {
    $rem = ($index - 1) % 26
    $name = [char](65 + $rem) + $name
    $index = [int][math]::Floor(($index - 1) / 26)
  }
  return $name
}

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$CatalogPath = Join-Path $root "db\catalog.json"
$ImageDir = Join-Path $root "assets\products"

$json = [System.IO.File]::ReadAllText($CatalogPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$categories = @($json.categories)
$products = @($json.products)
if ($categories.Count -ne 5) { throw "Expected 5 categories, found $($categories.Count)" }
if ($products.Count -ne 73) { throw "Expected 73 products, found $($products.Count)" }

$categoryName = @{}
foreach ($category in $categories) { $categoryName[[string]$category.slug] = [string]$category.name }

$rows = @()
$index = 0
foreach ($product in $products) {
  $index++
  $minPrice = ($product.denominations | Measure-Object -Property price -Minimum).Minimum
  $rows += [pscustomobject][ordered]@{
    No          = $index
    slug        = [string]$product.slug
    Name        = [string]$product.name
    Category    = $categoryName[[string]$product.category]
    MinPrice    = [int]$minPrice
    Icon        = [string]$product.icon
    Color       = [string]$product.color
    Image       = ""
    Rights      = ""
    Status      = "Belum ada"
  }
}

$headers = @("No", "slug", "Nama Produk", "Kategori", "Harga Mulai", "Icon Lama", "Warna", "Gambar (nama file)", "Sumber / Hak Pakai", "Status")
$lastCol = Col $headers.Count

# ---------------------------------------------------------------- shared strings
$strings = New-Object System.Collections.Generic.List[string]
$stringIndex = @{}
function Intern([string]$value) {
  if ($null -eq $value) { $value = "" }
  if ($stringIndex.ContainsKey($value)) { return $stringIndex[$value] }
  $i = $strings.Count
  $strings.Add($value)
  $stringIndex[$value] = $i
  return $i
}

function TextCell([string]$ref, [string]$value, [int]$style) {
  $i = Intern $value
  return '<c r="' + $ref + '" s="' + $style + '" t="s"><v>' + $i + '</v></c>'
}

function NumberCell([string]$ref, $value, [int]$style) {
  $inv = [System.Globalization.CultureInfo]::InvariantCulture
  return '<c r="' + $ref + '" s="' + $style + '"><v>' + ([double]$value).ToString($inv) + '</v></c>'
}

# ---------------------------------------------------------------- sheet 1
$sheetRows = New-Object System.Collections.Generic.List[string]
$cellStyles = @{}

function Add-Row([int]$rowNumber, [string[]]$cellsXml, [double]$height, [int]$customFormat) {
  $attrs = ' r="' + $rowNumber + '"'
  if ($height -gt 0) { $attrs += ' ht="' + $height + '" customHeight="1"' }
  if ($customFormat) { $attrs += ' customFormat="1" s="' + $customFormat + '"' }
  $script:sheetRows.Add('<row' + $attrs + '>' + ($cellsXml -join "") + '</row>')
}

$merged = @()

# Title row (A1:J1)
Intern "DATABASE GAMBAR PRODUK - thegadzstore"
$titleCells = @(TextCell "A1" "DATABASE GAMBAR PRODUK - thegadzstore" 1)
for ($c = 2; $c -le $headers.Count; $c++) { $titleCells += '<c r="' + (Col $c) + '1" s="1"/>' }
Add-Row 1 $titleCells 26 0
$merged += 'A1:J1'

# Help row (A2:J2)
$help = "Isi kolom 'Gambar (nama file)' dengan nama file yang sudah disimpan di folder assets\products, contoh: mobile-legends.png. Rasio 1:1, minimal 300x300 px, PNG/JPG/WEBP. Kosongkan bila belum ada, situs menampilkan cover gradien otomatis."
$helpCells = @(TextCell "A2" $help 2)
for ($c = 2; $c -le $headers.Count; $c++) { $helpCells += '<c r="' + (Col $c) + '2" s="2"/>' }
Add-Row 2 $helpCells 34 0
$merged += 'A2:J2'

Add-Row 3 @() 8 0

# Header row
$headerCells = @()
for ($c = 0; $c -lt $headers.Count; $c++) {
  $headerCells += (TextCell ((Col ($c + 1)) + "4") $headers[$c] 3)
}
Add-Row 4 $headerCells 24 0

# Data rows
$r = 5
foreach ($row in $rows) {
  $cells = @()
  $cells += NumberCell ("A$r") $row.No 6
  $cells += TextCell ("B$r") $row.slug 5
  $cells += TextCell ("C$r") $row.Name 5
  $cells += TextCell ("D$r") $row.Category 5
  $cells += NumberCell ("E$r") $row.MinPrice 4
  $cells += TextCell ("F$r") $row.Icon 5
  $cells += TextCell ("G$r") $row.Color 5
  $cells += TextCell ("H$r") $row.Image 5
  $cells += TextCell ("I$r") $row.Rights 5
  $cells += TextCell ("J$r") $row.Status 5
  Add-Row $r $cells 18 0
  $r++
}
$lastRow = $r - 1

# =Sheet1!$A$4:$J$4
$tableRef = "A4:" + $lastCol + $r
$filterRef = "A4:" + $lastCol + $lastRow

# ---------------------------------------------------------------- sheet 2 (guide)
$guideRows = New-Object System.Collections.Generic.List[string]
$guideStrings = @()
$guideLines = @(
  @("CARA PAKAI DATABASE GAMBAR", 1),
  @("", 0),
  @("1. Simpan file gambar ke folder assets\products\ (di dalam folder proyek).", 0),
  @("2. Nama file sebaiknya sama dengan slug produk, contoh: assets\products\mobile-legends.png", 0),
  @("3. Tulis nama file tersebut di kolom 'Gambar (nama file)', termasuk ekstensinya.", 0),
  @("4. Ubah kolom 'Status' menjadi 'Sudah ada'.", 0),
  @("5. Isi kolom 'Sumber / Hak Pakai' (contoh: desain sendiri, lisensi resmi publisher).", 0),
  @("6. Simpan file Excel ini, lalu jalankan:", 0),
  @("   powershell -ExecutionPolicy Bypass -File db\import-images.ps1", 2),
  @("", 0),
  @("SPESIFIKASI GAMBAR", 1),
  @("Rasio      : 1:1 (kotak)", 0),
  @("Ukuran     : minimal 300x300 px, disarankan 600x600 px", 0),
  @("Format     : PNG, JPG, atau WEBP", 0),
  @("Ukuran file: maksimal sekitar 200 KB", 0),
  @("Latar      : penuh (tidak transparan)", 0),
  @("", 0),
  @("CATATAN PENTING", 1),
  @("Produk tanpa gambar tetap tampil memakai cover gradien otomatis, jadi situs tidak pernah menampilkan kotak rusak.", 0),
  @("Jangan mengubah kolom 'slug', karena itu kunci penghubung ke database.", 0),
  @("Gunakan hanya gambar yang Anda miliki hak pakainya. Jangan menyalin logo atau artwork milik orang lain.", 0)
)
$gr = 1
foreach ($line in $guideLines) {
  $text = [string]$line[0]
  $style = [int]$line[1]
  if ($text -eq "") {
    $guideRows.Add('<row r="' + $gr + '"/>')
  } else {
    $i = Intern $text
    $guideRows.Add('<row r="' + $gr + '" ht="19" customHeight="1"><c r="A' + $gr + '" s="' + (7 + $style) + '" t="s"><v>' + $i + '</v></c></row>')
  }
  $gr++
}

# ---------------------------------------------------------------- parts
$ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

$colsXml = @()
$widths = @(6, 26, 34, 20, 14, 11, 11, 44, 34, 14)
for ($c = 0; $c -lt $widths.Count; $c++) {
  $n = $c + 1
  $colsXml += '<col min="' + $n + '" max="' + $n + '" width="' + $widths[$c] + '" customWidth="1"/>'
}

$sheet1 = @()
$sheet1 += '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
$sheet1 += '<worksheet ' + $ns + '>'
$sheet1 += '<sheetPr><tabColor rgb="FF05CE78"/></sheetPr>'
$sheet1 += '<dimension ref="A1:' + $lastCol + $lastRow + '"/>'
$sheet1 += '<sheetViews><sheetView tabSelected="1" workbookViewId="0"><pane ySplit="4" topLeftCell="A5" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="H5" sqref="H5"/></sheetView></sheetViews>'
$sheet1 += '<sheetFormatPr defaultRowHeight="18"/>'
$sheet1 += '<cols>' + ($colsXml -join "") + '</cols>'
$sheet1 += '<sheetData>' + ($sheetRows -join "") + '</sheetData>'
$sheet1 += '<autoFilter ref="' + $filterRef + '"/>'
if ($merged.Count) {
  $sheet1 += '<mergeCells count="' + $merged.Count + '">' + (($merged | ForEach-Object { '<mergeCell ref="' + $_ + '"/>' }) -join "") + '</mergeCells>'
}
$sheet1 += '<conditionalFormatting sqref="J5:J' + $lastRow + '"><cfRule type="cellIs" dxfId="0" priority="1" operator="equal"><formula>"Sudah ada"</formula></cfRule><cfRule type="cellIs" dxfId="1" priority="2" operator="equal"><formula>"Belum ada"</formula></cfRule></conditionalFormatting>'
$sheet1 += '<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>'
$sheet1 += '<pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/>'
$sheet1 += '</worksheet>'

$sheet2 = @()
$sheet2 += '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
$sheet2 += '<worksheet ' + $ns + '>'
$sheet2 += '<dimension ref="A1:A' + ($gr - 1) + '"/>'
$sheet2 += '<sheetViews><sheetView workbookViewId="0"><selection activeCell="A1" sqref="A1"/></sheetView></sheetViews>'
$sheet2 += '<sheetFormatPr defaultRowHeight="19"/>'
$sheet2 += '<cols><col min="1" max="1" width="96" customWidth="1"/></cols>'
$sheet2 += '<sheetData>' + ($guideRows -join "") + '</sheetData>'
$sheet2 += '<pageMargins left="0.7" right="0.7" top="0.7" bottom="0.7" header="0.3" footer="0.3"/>'
$sheet2 += '</worksheet>'

$sharedStrings = @()
$sharedStrings += '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
$sharedStrings += '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="' + $strings.Count + '" uniqueCount="' + $strings.Count + '">'
foreach ($s in $strings) {
  $sharedStrings += '<si><t xml:space="preserve">' + (Esc $s) + '</t></si>'
}
$sharedStrings += '</sst>'

$styles = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;Rp&quot;#,##0"/></numFmts>
<fonts count="6">
<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="16"/><color rgb="FF11181C"/><name val="Calibri"/><family val="2"/></font>
<font><sz val="10"/><color rgb="FF6B7280"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>
<font><sz val="11"/><color rgb="FF11181C"/><name val="Consolas"/><family val="2"/></font>
<font><b/><sz val="12"/><color rgb="FF11181C"/><name val="Calibri"/><family val="2"/></font>
</fonts>
<fills count="5">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF05CE78"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF3F6F5"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFE6F9F0"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FFD9E2DE"/></left><right style="thin"><color rgb="FFD9E2DE"/></right><top style="thin"><color rgb="FFD9E2DE"/></top><bottom style="thin"><color rgb="FFD9E2DE"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="10">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="3" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="5" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="4" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
<dxfs count="2">
<dxf><font><b/><color rgb="FFFFFFFF"/></font><fill><patternFill patternType="solid"><fgColor rgb="FF0E9F6E"/><bgColor rgb="FF0E9F6E"/></patternFill></fill></dxf>
<dxf><font><color rgb="FF6B7280"/></font><fill><patternFill patternType="solid"><fgColor rgb="FFF0F2F1"/><bgColor rgb="FFF0F2F1"/></patternFill></fill></dxf>
</dxfs>
<tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>
</styleSheet>
'@

$workbookXml = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<workbookPr/>
<bookViews><workbookView activeTab="0"/></bookViews>
<sheets>
<sheet name="Gambar Produk" sheetId="1" r:id="rId1"/>
<sheet name="Cara Pakai" sheetId="2" r:id="rId2"/>
</sheets>
<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'Gambar Produk'!$A$4:$J$LASTROW</definedName></definedNames>
<calcPr calcId="191029"/>
</workbook>
'@
$workbookXml = $workbookXml.Replace("`$LASTROW", $lastRow)

$wbRels = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>
'@

$rootRels = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>
'@

$coreXml = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>Database Gambar Produk - thegadzstore</dc:title>
<dc:creator>thegadzstore</dc:creator>
</cp:coreProperties>
'@

$appXml = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
<Application>Microsoft Excel</Application>
</Properties>
'@

$contentTypes = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>
'@

# ---------------------------------------------------------------- write the zip
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$encoding = New-Object System.Text.UTF8Encoding($false)

function Add-Entry($zip, [string]$name, [string]$content, $encoding) {
  $entry = $zip.CreateEntry($name, [System.IO.Compression.CompressionLevel]::Optimal)
  $stream = $entry.Open()
  $bytes = $encoding.GetBytes($content)
  $stream.Write($bytes, 0, $bytes.Length)
  $stream.Close()
}

if (Test-Path $OutPath) { Remove-Item $OutPath -Force }
$dir = Split-Path -Parent $OutPath
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

$zipStream = [System.IO.File]::Open($OutPath, [System.IO.FileMode]::CreateNew)
$zip = New-Object System.IO.Compression.ZipArchive($zipStream, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  Add-Entry $zip "[Content_Types].xml" $contentTypes $encoding
  Add-Entry $zip "_rels/.rels" $rootRels $encoding
  Add-Entry $zip "docProps/core.xml" $coreXml $encoding
  Add-Entry $zip "docProps/app.xml" $appXml $encoding
  Add-Entry $zip "xl/workbook.xml" $workbookXml $encoding
  Add-Entry $zip "xl/_rels/workbook.xml.rels" $wbRels $encoding
  Add-Entry $zip "xl/styles.xml" $styles $encoding
  Add-Entry $zip "xl/sharedStrings.xml" ($sharedStrings -join "`n") $encoding
  Add-Entry $zip "xl/worksheets/sheet1.xml" ($sheet1 -join "`n") $encoding
  Add-Entry $zip "xl/worksheets/sheet2.xml" ($sheet2 -join "`n") $encoding
} finally {
  $zip.Dispose()
  $zipStream.Close()
}

# CSV mirror for version control / diffing
$csvPath = [System.IO.Path]::ChangeExtension($OutPath, ".csv")
$rows | Select-Object No, slug, Name, Category, MinPrice, Color, Image, Rights, Status |
  Export-Csv -Path $csvPath -NoTypeInformation -Encoding UTF8

if (-not (Test-Path $ImageDir)) { New-Item -ItemType Directory -Path $ImageDir -Force | Out-Null }
$readme = Join-Path $ImageDir "README.md"
if (-not (Test-Path $readme)) {
  $readmeText = @"
# Gambar produk

Simpan file gambar produk di folder ini dengan nama yang sama seperti yang
ditulis pada kolom **Gambar (nama file)** di ``db/product-images.xlsx``.

- Rasio 1:1 (kotak), minimal 300x300 px, disarankan 600x600 px
- Format PNG / JPG / WEBP, maksimal sekitar 200 KB
- Produk tanpa file gambar otomatis memakai cover gradien, bukan kotak rusak
- Gunakan hanya gambar yang Anda miliki hak pakainya
"@
  [System.IO.File]::WriteAllText($readme, $readmeText, (New-Object System.Text.UTF8Encoding($false)))
}

Write-Host "Wrote $OutPath"
Write-Host "Wrote $csvPath"
Write-Host "Image folder: $ImageDir"
Write-Host "Rows: $($rows.Count)"
