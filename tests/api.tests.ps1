param(
  [string]$ApiBase = $env:API_BASE
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$envFile = Join-Path $root ".env"
$envLines = Get-Content $envFile
function Get-Env([string]$name) {
  $v = ($envLines | Where-Object { $_ -match "^\s*$name\s*=" }) -replace '^\s*[^=]+\s*=\s*', ''
  return $v.Trim().Trim('"').Trim("'")
}

if (-not $ApiBase) { $ApiBase = "https://gadzstore-api.blueicespeed.workers.dev" }
$ApiBase = $ApiBase.TrimEnd('/')
$AdminToken = Get-Env "ADMIN_TOKEN"
$WebhookSecret = Get-Env "QRIS_WEBHOOK_SECRET"

$script:Pass = 0
$script:Fail = 0
$script:Failures = @()

function Write-Pass([string]$name) {
  $script:Pass++
  Write-Host "PASS  $name" -ForegroundColor Green
}
function Write-Fail([string]$name, [string]$reason) {
  $script:Fail++
  $script:Failures += "$name :: $reason"
  Write-Host "FAIL  $name" -ForegroundColor Red
  Write-Host "      $reason" -ForegroundColor DarkRed
}
function Assert-Equal($expected, $actual, [string]$message) {
  if ($expected -ne $actual) { throw "$message (expected [$expected], got [$actual])" }
}
function Assert-NotEqual($expected, $actual, [string]$message) {
  if ($expected -eq $actual) { throw "$message (both [$actual])" }
}
function Assert-True([bool]$condition, [string]$message) {
  if (-not $condition) { throw $message }
}
function Assert-Match([string]$pattern, [string]$value, [string]$message) {
  if ($value -notmatch $pattern) { throw "$message (value [$value] does not match $pattern)" }
}

function Invoke-Api {
  param(
    [string]$Method = "GET",
    [string]$Path,
    $Body = $null,
    [hashtable]$Headers = @{},
    [string]$RawBody = $null
  )
  # HttpClient is used instead of Invoke-WebRequest because PS 5.1 drops the
  # response body on 4xx/5xx, which hides the JSON error contract under test.
  # Catatan: jangan pakai [System.Net.Http.HttpMethod]::$Method. .NET Framework
  # 4.x hanya punya properti statis GET/POST/PUT/DELETE; PATCH (dan method lain)
  # tidak ada sebagai properti, sehingga PowerShell mengembalikan $null dan
  # konstruktor HttpRequestMessage melempar "Value cannot be null. method".
  # Konstruktor HttpMethod dari string berlaku untuk semua method.
  Add-Type -AssemblyName System.Net.Http
  $uri = "$ApiBase$Path"
  $client = New-Object System.Net.Http.HttpClient
  $client.Timeout = [TimeSpan]::FromSeconds(45)
  $request = New-Object System.Net.Http.HttpRequestMessage((New-Object System.Net.Http.HttpMethod($Method.ToUpperInvariant())), $uri)
  try {
    $payload = $null
    if (-not [string]::IsNullOrEmpty($RawBody)) {
      $payload = $RawBody
    } elseif ($null -ne $Body) {
      $payload = ($Body | ConvertTo-Json -Depth 10 -Compress)
    }
    if ($null -ne $payload) {
      $request.Content = New-Object System.Net.Http.StringContent($payload, [System.Text.Encoding]::UTF8, "application/json")
    }
    foreach ($key in $Headers.Keys) {
      [void]$request.Headers.TryAddWithoutValidation($key, [string]$Headers[$key])
    }
    $res = $client.SendAsync($request).GetAwaiter().GetResult()
    $raw = $res.Content.ReadAsStringAsync().Result
    $json = $null
    try { $json = $raw | ConvertFrom-Json } catch {}
    return [pscustomobject]@{ Status = [int]$res.StatusCode; Json = $json; Raw = $raw }
  } finally {
    $request.Dispose()
    $client.Dispose()
  }
}

function Test-Case([string]$name, [scriptblock]$body) {
  $script:CaseSkipped = $false
  try {
    & $body
    # `return` di dalam body hanya keluar dari scriptblock itu dan tidak melempar
    # error, jadi tanpa penanda ini tes yang di-SKIP dihitung PASS.
    if ($script:CaseSkipped) {
      $script:CaseSkipped = $false
      return
    }
    Write-Pass $name
  } catch {
    $script:CaseSkipped = $false
    Write-Fail $name $_.Exception.Message
  }
}

# Hentikan satu tes tanpa menghitungnya sebagai PASS (juga tetap memicu `finally`).
function Skip-Case([string]$reason) {
  Write-Host "SKIP  $reason" -ForegroundColor Yellow
  $script:CaseSkipped = $true
  return
}
function Get-AdminHeaders {
  return @{ Authorization = "Bearer $AdminToken" }
}

function New-HmacHex([string]$text, [string]$key) {
  $hmac = New-Object System.Security.Cryptography.HMACSHA256
  $hmac.Key = [Text.Encoding]::UTF8.GetBytes($key)
  $hash = $hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($text))
  return (($hash | ForEach-Object { $_.ToString("x2") }) -join "")
}

function New-QrisTlv([string]$tag, [string]$value) {
  return $tag + ($value.Length.ToString("00")) + $value
}

function Get-QrisCrc([string]$payloadWithoutCrc) {
  $crc = 0xFFFF
  $bytes = [Text.Encoding]::UTF8.GetBytes($payloadWithoutCrc)
  foreach ($b in $bytes) {
    $crc = $crc -bxor ((([int]$b) -shl 8))
    for ($i = 0; $i -lt 8; $i++) {
      if (($crc -band 0x8000) -ne 0) {
        $crc = ((($crc -shl 1) -bxor 0x1021) -band 0xFFFF)
      } else {
        $crc = (($crc -shl 1) -band 0xFFFF)
      }
    }
  }
  return $crc.ToString("X4")
}

function New-TestQrisPayload {
  $merchant = (New-QrisTlv "00" "ID.CO.QRIS.WWW") +
              (New-QrisTlv "01" "936000000000000000") +
              (New-QrisTlv "02" "ID1234567890") +
              (New-QrisTlv "03" "UMI")
  $payload = (New-QrisTlv "00" "01") +
             (New-QrisTlv "01" "11") +
             (New-QrisTlv "26" $merchant) +
             (New-QrisTlv "52" "5812") +
             (New-QrisTlv "53" "360") +
             (New-QrisTlv "58" "ID") +
             (New-QrisTlv "59" "THEGADZ STORE") +
             (New-QrisTlv "60" "JAKARTA") +
             (New-QrisTlv "61" "10110") +
             "6304"
  return $payload + (Get-QrisCrc $payload)
}

Write-Host ""
Write-Host "TheGadz Store API contract tests" -ForegroundColor Cyan
Write-Host "API: $ApiBase" -ForegroundColor DarkGray
Write-Host ""

# ---------------------------------------------------------------- health
Test-Case "health returns ok and database is reachable" {
  $r = Invoke-Api -Path "/api/health"
  Assert-Equal 200 $r.Status "health status"
  Assert-Equal $true $r.Json.ok "health ok"
  Assert-Equal "ok" $r.Json.db "health db"
}

# ---------------------------------------------------------------- config
Test-Case "config exposes store, qris mode, fee and demo flag" {
  $r = Invoke-Api -Path "/api/config"
  Assert-Equal 200 $r.Status "config status"
  Assert-True ($r.Json.store.name.Length -gt 0) "store name missing"
  Assert-True ($r.Json.qris.mode -in @("demo", "static", "image")) "qris mode invalid"
  Assert-True ($r.Json.qris.image -match "^assets/qris/") "qris image path missing"
  Assert-Equal ($r.Json.qris.mode -eq "static") $r.Json.qris.amount_in_payload "amount_in_payload must follow static mode"
  Assert-True ($r.Json.qris.fee_percent -ge 0) "fee percent missing"
  Assert-True ($null -ne $r.Json.demo) "demo flag missing"
  Assert-True ($r.Json.order_ttl_seconds -gt 0) "ttl missing"
}

# ---------------------------------------------------------------- catalog
$script:Catalog = $null
Test-Case "catalog returns categories with products" {
  $r = Invoke-Api -Path "/api/catalog"
  Assert-Equal 200 $r.Status "catalog status"
  Assert-True ($r.Json.categories.Count -ge 5) "expected at least 5 categories"
  $script:Catalog = $r.Json
  $names = @($r.Json.categories | ForEach-Object { $_.name })
  Assert-True ($names -contains "Top Up Game") "Top Up Game category missing"
  Assert-True ($names -contains "Voucher") "Voucher category missing"
  foreach ($c in $r.Json.categories) {
    Assert-True ($c.products.Count -gt 0) "category $($c.slug) has no products"
    foreach ($p in $c.products) {
      Assert-True ($p.min_price -gt 0) "product $($p.slug) has no price"
      Assert-Match "^[a-z0-9-]+$" $p.slug "invalid product slug"
    }
  }
}

# ---------------------------------------------------------------- product
$script:Product = $null
Test-Case "product detail returns denominations" {
  $r = Invoke-Api -Path "/api/products/mobile-legends"
  Assert-Equal 200 $r.Status "product status"
  Assert-Equal "mobile-legends" $r.Json.product.slug "product slug"
  Assert-True ($r.Json.product.requires_zone -eq $true) "MLBB should require zone"
  Assert-True ($r.Json.denominations.Count -ge 4) "expected denominations"
  foreach ($d in $r.Json.denominations) {
    Assert-True ($d.price -gt 0) "denomination price missing"
    Assert-True ($d.label.Length -gt 0) "denomination label missing"
  }
  $script:Product = $r.Json
}

Test-Case "unknown product returns 404" {
  $r = Invoke-Api -Path "/api/products/does-not-exist"
  Assert-Equal 404 $r.Status "unknown product"
}

# ---------------------------------------------------------------- order validation
Test-Case "order rejects invalid player id" {
  $denom = $script:Product.denominations[0]
  $r = Invoke-Api -Method POST -Path "/api/orders" -Body @{
    product_slug = "mobile-legends"; denomination_id = $denom.id; player_id = "abc"; zone_id = "2145"
  }
  Assert-Equal 400 $r.Status "invalid player id"
}

Test-Case "order rejects missing zone when required" {
  $denom = $script:Product.denominations[0]
  $r = Invoke-Api -Method POST -Path "/api/orders" -Body @{
    product_slug = "mobile-legends"; denomination_id = $denom.id; player_id = "88291034"; zone_id = ""
  }
  Assert-Equal 400 $r.Status "missing zone"
}

Test-Case "order rejects unknown denomination" {
  $r = Invoke-Api -Method POST -Path "/api/orders" -Body @{
    product_slug = "mobile-legends"; denomination_id = 999999; player_id = "88291034"; zone_id = "2145"
  }
  Assert-Equal 400 $r.Status "unknown denomination"
}

# ---------------------------------------------------------------- order creation
$script:Order = $null
Test-Case "order is priced on the server and starts pending" {
  $script:QrisConfig = (Invoke-Api -Path "/api/config").Json.qris
  $denom = $script:Product.denominations[0]
  $r = Invoke-Api -Method POST -Path "/api/orders" -Body @{
    product_slug = "mobile-legends"
    denomination_id = $denom.id
    player_id = "88291034"
    zone_id = "2145"
    total = 1
    subtotal = 1
    fee = 0
  }
  Assert-Equal 201 $r.Status "create order status"
  Assert-Match "^TG[A-Z0-9]{6,12}$" $r.Json.order.public_id "public id format"
  Assert-Equal $denom.price $r.Json.order.subtotal "subtotal must come from server"
  Assert-NotEqual 1 $r.Json.order.total "client total must be ignored"
  Assert-Equal "pending" $r.Json.order.status "initial status"
  if ($script:QrisConfig.mode -eq "static") {
    Assert-True ($r.Json.order.qr_payload.Length -gt 10) "qr payload missing"
  } else {
    Assert-True ([string]::IsNullOrEmpty($r.Json.order.qr_payload)) "image QR mode must not issue a payload"
  }
  Assert-True ($r.Json.order.total -ge $r.Json.order.subtotal) "total below subtotal"
  $script:Order = $r.Json.order
}

Test-Case "order can be looked up with a timeline" {
  $r = Invoke-Api -Path "/api/orders/$($script:Order.public_id)"
  Assert-Equal 200 $r.Status "lookup status"
  Assert-Equal $script:Order.public_id $r.Json.order.public_id "lookup id"
  Assert-Equal "pending" $r.Json.order.status "lookup status value"
  Assert-True ($r.Json.order.events.Count -ge 1) "timeline missing"
}

Test-Case "unknown order returns 404" {
  $r = Invoke-Api -Path "/api/orders/TGUNKNOWN1"
  Assert-Equal 404 $r.Status "unknown order"
}

# ---------------------------------------------------------------- admin auth
Test-Case "admin rejects missing token" {
  $r = Invoke-Api -Path "/api/admin/orders"
  Assert-Equal 401 $r.Status "admin without token"
}

Test-Case "admin rejects wrong token" {
  $r = Invoke-Api -Path "/api/admin/orders" -Headers @{ Authorization = "Bearer definitely-wrong" }
  Assert-Equal 401 $r.Status "admin wrong token"
}

Test-Case "admin lists orders" {
  $r = Invoke-Api -Path "/api/admin/orders?limit=5" -Headers (Get-AdminHeaders)
  Assert-Equal 200 $r.Status "admin list"
  Assert-True ($r.Json.orders.Count -ge 1) "admin list empty"
}

# ---------------------------------------------------------------- admin transitions
Test-Case "admin marks order paid" {
  $r = Invoke-Api -Method POST -Path "/api/admin/orders/$($script:Order.public_id)/paid" -Headers (Get-AdminHeaders) -Body @{ reference = "manual-test" }
  Assert-Equal 200 $r.Status "mark paid"
  Assert-Equal "paid" $r.Json.order.status "paid status"
  Assert-True ($r.Json.order.paid_at.Length -gt 0) "paid_at missing"
}

Test-Case "duplicate mark paid is idempotent" {
  $r = Invoke-Api -Method POST -Path "/api/admin/orders/$($script:Order.public_id)/paid" -Headers (Get-AdminHeaders) -Body @{}
  Assert-Equal 200 $r.Status "duplicate paid"
  Assert-Equal "paid" $r.Json.order.status "duplicate paid status"
}

Test-Case "admin fulfills order with supplier reference" {
  $r = Invoke-Api -Method POST -Path "/api/admin/orders/$($script:Order.public_id)/fulfill" -Headers (Get-AdminHeaders) -Body @{ supplier_ref = "SUP-123" }
  Assert-Equal 200 $r.Status "fulfill"
  Assert-Equal "fulfilled" $r.Json.order.status "fulfilled status"
  Assert-Equal "SUP-123" $r.Json.order.supplier_ref "supplier ref"
}

Test-Case "duplicate fulfill is idempotent" {
  $r = Invoke-Api -Method POST -Path "/api/admin/orders/$($script:Order.public_id)/fulfill" -Headers (Get-AdminHeaders) -Body @{}
  Assert-Equal 200 $r.Status "duplicate fulfill"
  Assert-Equal "fulfilled" $r.Json.order.status "duplicate fulfill status"
}

Test-Case "admin cannot fulfill an unpaid order" {
  $denom = $script:Product.denominations[1]
  $created = Invoke-Api -Method POST -Path "/api/orders" -Body @{
    product_slug = "mobile-legends"; denomination_id = $denom.id; player_id = "88291035"; zone_id = "2145"
  }
  Assert-Equal 201 $created.Status "create unpaid order"
  $r = Invoke-Api -Method POST -Path "/api/admin/orders/$($created.Json.order.public_id)/fulfill" -Headers (Get-AdminHeaders) -Body @{}
  Assert-Equal 409 $r.Status "fulfill unpaid"
}

# ---------------------------------------------------------------- demo payment
Test-Case "demo-paid follows the demo flag" {
  $config = (Invoke-Api -Path "/api/config").Json
  $denom = $script:Product.denominations[2]
  $created = Invoke-Api -Method POST -Path "/api/orders" -Body @{
    product_slug = "mobile-legends"; denomination_id = $denom.id; player_id = "88291036"; zone_id = "2145"
  }
  Assert-Equal 201 $created.Status "create demo order"
  $r = Invoke-Api -Method POST -Path "/api/orders/$($created.Json.order.public_id)/demo-paid" -Body @{}
  if ($config.demo -eq $true) {
    Assert-Equal 200 $r.Status "demo paid enabled"
    Assert-Equal "paid" $r.Json.order.status "demo paid status"
  } else {
    Assert-Equal 403 $r.Status "demo paid must be disabled"
  }
}

# ---------------------------------------------------------------- webhook
Test-Case "webhook rejects a bad signature" {
  $body = @{ order_id = $script:Order.public_id; status = "paid" } | ConvertTo-Json -Compress
  $r = Invoke-Api -Method POST -Path "/api/webhooks/qris" -RawBody $body -Headers @{ "X-Signature" = "deadbeef" }
  Assert-Equal 401 $r.Status "bad signature"
}

Test-Case "webhook rejects a missing signature" {
  $body = @{ order_id = $script:Order.public_id; status = "paid" } | ConvertTo-Json -Compress
  $r = Invoke-Api -Method POST -Path "/api/webhooks/qris" -RawBody $body
  Assert-Equal 401 $r.Status "missing signature"
}

Test-Case "signed webhook marks a pending order paid and is idempotent" {
  $denom = $script:Product.denominations[3]
  $created = Invoke-Api -Method POST -Path "/api/orders" -Body @{
    product_slug = "mobile-legends"; denomination_id = $denom.id; player_id = "88291037"; zone_id = "2145"
  }
  Assert-Equal 201 $created.Status "create webhook order"
  $body = @{ order_id = $created.Json.order.public_id; status = "paid"; reference = "GW-1" } | ConvertTo-Json -Compress
  $sig = New-HmacHex $body $WebhookSecret
  $first = Invoke-Api -Method POST -Path "/api/webhooks/qris" -RawBody $body -Headers @{ "X-Signature" = $sig }
  Assert-Equal 200 $first.Status "webhook first"
  Assert-Equal "paid" $first.Json.order.status "webhook paid status"
  $second = Invoke-Api -Method POST -Path "/api/webhooks/qris" -RawBody $body -Headers @{ "X-Signature" = $sig }
  Assert-Equal 200 $second.Status "webhook repeat"
  Assert-Equal "paid" $second.Json.order.status "webhook repeat status"
}

# ---------------------------------------------------------------- qris conversion
Test-Case "admin preview converts static QRIS to a dynamic amount with valid CRC" {
  $sample = New-TestQrisPayload
  $r = Invoke-Api -Method POST -Path "/api/admin/qris/preview" -Headers (Get-AdminHeaders) -Body @{
    payload = $sample
    amount = 12345
  }
  Assert-Equal 200 $r.Status "qris preview"
  Assert-Equal $true $r.Json.crc_valid "crc validity"
  Assert-Equal 12345 $r.Json.amount "amount"
  Assert-True ($r.Json.payload -match "540512345") "tag 54 amount missing"
  Assert-True ($r.Json.payload.EndsWith($r.Json.crc)) "crc suffix mismatch"
}

Test-Case "qris preview rejects a malformed payload" {
  $r = Invoke-Api -Method POST -Path "/api/admin/qris/preview" -Headers (Get-AdminHeaders) -Body @{
    payload = "not-a-qris"
    amount = 1000
  }
  Assert-Equal 400 $r.Status "malformed qris"
}

# ---------------------------------------------------------------- payment proof
Add-Type -AssemblyName System.Net.Http

# Workerd's FormData parser requires a quoted Content-Disposition name
# (name="proof"). .NET's MultipartFormDataContent emits name=proof unquoted,
# so the body is assembled by hand to match what browsers send.
function New-ProofForm([byte[]]$Bytes, [string]$FileName = "bukti.png", [string]$Sender = "Tester") {
  $boundary = "----gadzstore" + [guid]::NewGuid().ToString("N")
  $ms = New-Object System.IO.MemoryStream
  function Write-Text([string]$text) {
    $chunk = [System.Text.Encoding]::UTF8.GetBytes($text)
    $ms.Write($chunk, 0, $chunk.Length)
  }
  Write-Text("--$boundary`r`nContent-Disposition: form-data; name=""proof""; filename=""$FileName""`r`nContent-Type: application/octet-stream`r`n`r`n")
  $ms.Write($Bytes, 0, $Bytes.Length)
  if ($Sender) {
    Write-Text("`r`n--$boundary`r`nContent-Disposition: form-data; name=""sender""`r`n`r`n$Sender")
  }
  Write-Text("`r`n--$boundary--`r`n")
  $payload = $ms.ToArray()
  $ms.Dispose()

  $content = New-Object System.Net.Http.ByteArrayContent(,$payload)
  [void]$content.Headers.TryAddWithoutValidation("Content-Type", "multipart/form-data; boundary=$boundary")
  return ,$content
}

function Invoke-ProofUpload {
  param([string]$PublicId, [byte[]]$Bytes, [string]$FileName = "bukti.png", [string]$Sender = "Tester")
  [byte[]]$bytes = $Bytes
  [System.Net.Http.HttpContent]$content = New-ProofForm $bytes $FileName $Sender
  $client = New-Object System.Net.Http.HttpClient
  $client.Timeout = [TimeSpan]::FromSeconds(45)
  try {
    $res = $client.PostAsync("$ApiBase/api/orders/$PublicId/proof", $content).GetAwaiter().GetResult()
    $raw = $res.Content.ReadAsStringAsync().Result
    $json = $null
    try { $json = $raw | ConvertFrom-Json } catch {}
    return [pscustomobject]@{ Status = [int]$res.StatusCode; Json = $json; Raw = $raw; Headers = $res.Headers }
  } finally {
    $client.Dispose()
    $content.Dispose()
  }
}

# Minimal but structurally valid PNG signature + IHDR so magic-byte sniffing accepts it.
function New-PngBytes([int]$Size = 2048) {
  $bytes = New-Object byte[] $Size
  $header = [byte[]](0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
  [Array]::Copy($header, $bytes, $header.Length)
  $tail = [byte[]](0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52)
  [Array]::Copy($tail, 0, $bytes, 8, $tail.Length)
  for ($i = 16; $i -lt $Size; $i++) { $bytes[$i] = [byte](($i * 7) % 251) }
  return ,$bytes
}

$script:PaymentConfig = (Invoke-Api -Path "/api/config").Json.payment

Test-Case "config advertises the payment mode and proof cap" {
  $p = $script:PaymentConfig
  Assert-True ($null -ne $p) "payment block missing from /api/config"
  Assert-True ($p.mode -in @("demo", "manual")) "payment mode invalid"
  Assert-True ($p.methods -contains "QRIS") "QRIS must always be a payment method"
  Assert-True ($null -ne $p.proof_upload) "proof_upload flag missing"
  Assert-True ($p.max_proof_bytes -gt 0) "max_proof_bytes missing"
  Assert-True ($p.max_proof_bytes -le 687761) "max_proof_bytes exceeds the D1-safe cap"
  Assert-Equal ($p.mode -eq "manual") $p.proof_upload "proof_upload must follow manual mode"
}

Test-Case "manual mode hides the QRIS demo button" {
  $config = (Invoke-Api -Path "/api/config").Json
  $denom = $script:Product.denominations[4]
  $created = Invoke-Api -Method POST -Path "/api/orders" -Body @{
    product_slug = "mobile-legends"; denomination_id = $denom.id; player_id = "88291038"; zone_id = "2145"
  }
  Assert-Equal 201 $created.Status "create guard order"
  if ($config.payment.mode -eq "manual") {
    Assert-Equal $false $config.demo "demo flag must be off in manual mode"
    $r = Invoke-Api -Method POST -Path "/api/orders/$($created.Json.order.public_id)/demo-paid" -Body @{}
    Assert-Equal 403 $r.Status "demo-paid must be refused"
    Assert-Equal "demo_disabled" $r.Json.error "demo-paid error code"
    $lookup = Invoke-Api -Path "/api/orders/$($created.Json.order.public_id)"
    Assert-Equal "pending" $lookup.Json.order.status "order must stay pending"
    # Non-static QRIS modes send an empty payload; the storefront shows the QR image instead.
    Assert-True ([string]::IsNullOrEmpty([string]$lookup.Json.order.qr_payload)) "manual mode must not issue an amount payload"
  } else {
    Assert-Equal $false $config.payment.proof_upload "proof_upload must be off in demo mode"
  }
  Invoke-Api -Method POST -Path "/api/admin/orders/$($created.Json.order.public_id)/cancel" -Headers (Get-AdminHeaders) -Body @{} | Out-Null
}

Test-Case "proof routes are gated by manual mode" {
  $denom = $script:Product.denominations[0]
  $created = Invoke-Api -Method POST -Path "/api/orders" -Body @{
    product_slug = "mobile-legends"; denomination_id = $denom.id; player_id = "88291039"; zone_id = "2145"
  }
  Assert-Equal 201 $created.Status "create proof-gate order"
  $id = $created.Json.order.public_id
  $upload = Invoke-ProofUpload -PublicId $id -Bytes (New-PngBytes 4096)
  $get = Invoke-Api -Path "/api/orders/$id/proof"
  if ($script:PaymentConfig.mode -eq "manual") {
    Assert-Equal 200 $upload.Status "proof upload should succeed in manual mode"
    Assert-Equal "image/png" $upload.Json.order.proof.mime "sniffed mime"
    Assert-Equal 200 $get.Status "proof fetch should succeed"
    $delete = Invoke-Api -Method DELETE -Path "/api/orders/$id/proof"
    Assert-Equal 200 $delete.Status "proof delete should succeed"
    Assert-Equal $null $delete.Json.order.proof "proof should be cleared"
  } else {
    Assert-Equal 403 $upload.Status "proof upload must be refused in demo mode"
    Assert-Equal "proof_disabled" $upload.Json.error "disabled error code"
    Assert-Equal 404 $get.Status "no proof should be stored"
  }
  Invoke-Api -Method POST -Path "/api/admin/orders/$id/cancel" -Headers (Get-AdminHeaders) -Body @{} | Out-Null
}

Test-Case "proof upload validates type and size before storing" {
  if ($script:PaymentConfig.mode -ne "manual") {
    # Demo mode refuses every upload, so the type/size guards cannot be reached over HTTP.
    Assert-Equal $false $script:PaymentConfig.proof_upload "proof_upload must be off in demo mode"
    return
  }
  $denom = $script:Product.denominations[1]
  $created = Invoke-Api -Method POST -Path "/api/orders" -Body @{
    product_slug = "mobile-legends"; denomination_id = $denom.id; player_id = "88291040"; zone_id = "2145"
  }
  $id = $created.Json.order.public_id
  $bogus = [Text.Encoding]::ASCII.GetBytes("this is definitely not an image at all")
  $bad = Invoke-ProofUpload -PublicId $id -Bytes $bogus -FileName "evil.png"
  Assert-Equal 415 $bad.Status "unsupported type"
  Assert-Equal "unsupported_proof" $bad.Json.error "unsupported error code"
  $huge = New-PngBytes ($script:PaymentConfig.max_proof_bytes + 4096)
  $big = Invoke-ProofUpload -PublicId $id -Bytes $huge -FileName "big.png"
  Assert-Equal 413 $big.Status "oversized proof"
  Assert-Equal "proof_too_large" $big.Json.error "oversized error code"
  Invoke-Api -Method POST -Path "/api/admin/orders/$id/cancel" -Headers (Get-AdminHeaders) -Body @{} | Out-Null
}

Test-Case "proof can be rejected with a reason and re-uploaded" {
  if ($script:PaymentConfig.mode -ne "manual") {
    Assert-Equal $false $script:PaymentConfig.proof_upload "proof_upload must be off in demo mode"
    return
  }
  $denom = $script:Product.denominations[2]
  $created = Invoke-Api -Method POST -Path "/api/orders" -Body @{
    product_slug = "mobile-legends"; denomination_id = $denom.id; player_id = "88291041"; zone_id = "2145"
  }
  $id = $created.Json.order.public_id
  $first = Invoke-ProofUpload -PublicId $id -Bytes (New-PngBytes 3072)
  Assert-Equal 200 $first.Status "first proof upload"
  Assert-True ($null -ne $first.Json.order.proof) "proof should be attached"
  Assert-True ($null -eq $first.Json.order.proof_rejection) "no rejection yet"
  $list = Invoke-Api -Path "/api/admin/orders?limit=200" -Headers (Get-AdminHeaders)
  $row = @($list.Json.orders | Where-Object { $_.public_id -eq $id })[0]
  Assert-True ($null -ne $row) "order missing from admin list"
  Assert-True ($null -ne $row.proof) "admin list must expose the proof block"
  Assert-True ([string]$row.proof.uploaded_at -match '^\d{4}-\d{2}-\d{2}T') "admin list proof must carry uploaded_at"
  Assert-True (-not ($row.PSObject.Properties.Name -contains "proof_data")) "admin list must not leak proof bytes"
  $reject = Invoke-Api -Method POST -Path "/api/admin/orders/$id/reject-proof" -Headers (Get-AdminHeaders) -Body @{ reason = "Nominal tidak sesuai" }
  Assert-Equal 200 $reject.Status "reject proof"
  Assert-Equal $null $reject.Json.order.proof "proof should be cleared after reject"
  Assert-Equal "Nominal tidak sesuai" $reject.Json.order.proof_rejection.reason "rejection reason"
  $reupload = Invoke-ProofUpload -PublicId $id -Bytes (New-PngBytes 5120) -Sender "Tester 2"
  Assert-Equal 200 $reupload.Status "re-upload after reject"
  Assert-True ($null -ne $reupload.Json.order.proof) "new proof should be attached"
  Assert-Equal $null $reupload.Json.order.proof_rejection "rejection should be cleared on re-upload"
  $pay = Invoke-Api -Method POST -Path "/api/admin/orders/$id/paid" -Headers (Get-AdminHeaders) -Body @{ reference = "proof-flow" }
  Assert-Equal 200 $pay.Status "mark paid after verified proof"
  Assert-Equal "paid" $pay.Json.order.status "paid status"
  $done = Invoke-Api -Method POST -Path "/api/admin/orders/$id/fulfill" -Headers (Get-AdminHeaders) -Body @{}
  Assert-Equal 200 $done.Status "fulfill after paid"
  Assert-Equal "fulfilled" $done.Json.order.status "fulfilled status"
}

# ---------------------------------------------------------------- harga
# Probe: pakai nominal aktif pertama sebagai sasaran uji tetap. Semua tes di
# blok ini mengembalikan nilai awal di `finally` supaya data katalog tidak ikut
# berubah saat tes dijalankan berulang.
$script:PriceProbe = (Invoke-Api -Path "/api/admin/prices" -Headers (Get-AdminHeaders)).Json.items |
  Where-Object { $_.active -eq 1 } | Select-Object -First 1
if ($null -eq $script:PriceProbe) { throw "Tidak ada nominal aktif untuk diuji" }
$script:PriceStart = [int]$script:PriceProbe.price
$script:PriceSlug = $script:PriceProbe.product_slug
$script:PriceDid = $script:PriceProbe.id
$script:PriceStartCompare = [int]$script:PriceProbe.compare_at

# requires_zone tidak dikembalikan oleh /api/admin/prices, jadi ambil sekali dari
# detail produk supaya body order di bawah hanya menyertakan zone saat perlu.
$script:PriceZone = ""
$script:PriceProduct = ($script:PriceProbe.product_slug)
$d = Invoke-Api -Path "/api/products/$($script:PriceProduct)"
if ($d.Status -eq 200) {
  $script:PriceRequiresZone = [bool]$d.Json.product.requires_zone
  if ($script:PriceRequiresZone) { $script:PriceZone = "2145" }
}

function Set-PricePatch($headers, $item) {
  return Invoke-Api -Method PATCH -Path "/api/admin/prices" -Headers $headers -Body @{ items = @($item) }
}

function New-PriceOrderBody([string]$playerId) {
  $body = @{ product_slug = $script:PriceSlug; denomination_id = $script:PriceDid; player_id = $playerId }
  if ($script:PriceZone) { $body.zone_id = $script:PriceZone }
  return $body
}

Test-Case "admin prices tanpa token ditolak" {
  $r = Invoke-Api -Path "/api/admin/prices" -Headers @{}
  Assert-Equal 401 $r.Status "harus 401 tanpa token"
}

Test-Case "admin prices mengembalikan 310 nominal dengan field wajib" {
  $r = Invoke-Api -Path "/api/admin/prices" -Headers (Get-AdminHeaders)
  Assert-Equal 200 $r.Status "status daftar harga"
  Assert-Equal 310 $r.Json.items.Count "jumlah nominal"
  # updated_at = null sampai perubahan harga pertama tercatat (UI menampilkan
  # "belum pernah"). Assert tipe, bukan keberadaan: ConvertFrom-Json tetap membuat
  # properti bernilai null, sehingga `-contains "updated_at"` tidak membuktikan apa pun.
  Assert-True ($null -eq $r.Json.updated_at -or $r.Json.updated_at -is [string]) "updated_at harus null atau string"
  if ($null -ne $r.Json.updated_at) {
    Assert-Match '^\d{4}-\d{2}-\d{2}T' ([string]$r.Json.updated_at) "updated_at harus ISO-8601 bila terisi"
  }
  foreach ($it in $r.Json.items) {
    Assert-True ($it.id -is [int] -and $it.id -ge 1) "id nominal tidak valid"
    Assert-True ($it.sku.Length -gt 0) "sku kosong pada nominal $($it.id)"
    Assert-True ($it.label.Length -gt 0) "label kosong pada nominal $($it.id)"
    Assert-True ($it.product_slug.Length -gt 0) "product_slug kosong pada nominal $($it.id)"
    Assert-True ($it.product_name.Length -gt 0) "product_name kosong pada nominal $($it.id)"
    Assert-True ($it.category_name.Length -gt 0) "category_name kosong pada nominal $($it.id)"
    Assert-True ($it.price -gt 0) "price kosong pada nominal $($it.id)"
    Assert-True ($it.compare_at -ge 0) "compare_at tidak valid pada nominal $($it.id)"
    Assert-True ($it.active -eq 0 -or $it.active -eq 1) "active tidak valid pada nominal $($it.id)"
    Assert-True ($it.PSObject.Properties.Name -contains "last_change") "last_change wajib ada pada nominal $($it.id)"
    if ($null -ne $it.last_change) {
      Assert-True ($it.last_change.new_price -gt 0) "last_change.new_price tidak valid pada nominal $($it.id)"
      Assert-Match '^\d{4}-\d{2}-\d{2}T' ([string]$it.last_change.changed_at) "last_change.changed_at tidak valid pada nominal $($it.id)"
    }
  }
}

Test-Case "naik harga tercermin di product dan catalog" {
  $newPrice = $script:PriceStart + 2500
  try {
    $res = Set-PricePatch (Get-AdminHeaders) @{ id = $script:PriceDid; price = $newPrice }
    Assert-Equal 200 $res.Status "patch harga"
    Assert-Equal $newPrice (@($res.Json.items | Where-Object { $_.id -eq $script:PriceDid })[0].price) "harga baru di respons"

    $detail = Invoke-Api -Path "/api/products/$($script:PriceSlug)"
    $row = @($detail.Json.denominations | Where-Object { $_.id -eq $script:PriceDid })[0]
    Assert-Equal $newPrice $row.price "harga di product detail"

    $cat = Invoke-Api -Path "/api/catalog"
    $prod = @($cat.Json.categories.products | Where-Object { $_.slug -eq $script:PriceSlug })[0]
    $all = @((Invoke-Api -Path "/api/products/$($script:PriceSlug)").Json.denominations | Where-Object { $_.id -ne $script:PriceDid })
    $expectedMin = $newPrice
    foreach ($x in $all) { if ($x.price -lt $expectedMin) { $expectedMin = $x.price } }
    Assert-Equal $expectedMin $prod.min_price "min_price di catalog setelah naik harga"
  } finally {
    Set-PricePatch (Get-AdminHeaders) @{ id = $script:PriceDid; price = $script:PriceStart } | Out-Null
  }
}

Test-Case "perubahan harga menulis baris audit history" {
  $newPrice = $script:PriceStart + 4000
  $before = (Invoke-Api -Path "/api/admin/prices/history?denomination_id=$($script:PriceDid)&limit=1" -Headers (Get-AdminHeaders)).Json.items
  $beforeTop = if ($before.Count -gt 0) { $before[0].id } else { 0 }
  try {
    $res = Set-PricePatch (Get-AdminHeaders) @{ id = $script:PriceDid; price = $newPrice; note = "tes audit" }
    Assert-Equal 200 $res.Status "patch harga untuk audit"
    Assert-Equal 1 $res.Json.changed "patch audit harus mengubah 1 nominal"
    $hist = Invoke-Api -Path "/api/admin/prices/history?denomination_id=$($script:PriceDid)&limit=10" -Headers (Get-AdminHeaders)
    Assert-Equal 200 $hist.Status "status history"
    $row = @($hist.Json.items | Where-Object { $_.id -gt $beforeTop })[0]
    if ($null -eq $row) { throw "baris audit baru tidak ditemukan (beforeTop=$beforeTop, count=$($hist.Json.items.Count))" }
    Assert-Equal $script:PriceDid $row.denomination_id "denomination_id baris audit"
    Assert-Equal $script:PriceStart $row.old_price "old_price baris audit"
    Assert-Equal $newPrice $row.new_price "new_price baris audit"
    Assert-Equal "admin" $row.source "source baris audit"
    Assert-Equal "tes audit" $row.note "note baris audit"
    Assert-Match '^\d{4}-\d{2}-\d{2}T' ([string]$row.changed_at) "changed_at baris audit"
  } finally {
    Set-PricePatch (Get-AdminHeaders) @{ id = $script:PriceDid; price = $script:PriceStart } | Out-Null
  }
}

Test-Case "compare_at di bawah harga ditolak dan harga tidak berubah" {
  if ($script:PriceStart -lt 2) { Skip-Case "compare_at di bawah harga :: harga awal $($script:PriceStart) tidak bisa diturunkan"; return }
  $res = Set-PricePatch (Get-AdminHeaders) @{ id = $script:PriceDid; price = $script:PriceStart; compare_at = $script:PriceStart - 1 }
  Assert-Equal 400 $res.Status "compare_at di bawah harga"
  Assert-Equal "invalid_compare_at" $res.Json.error "kode error compare_at"
  $after = (Invoke-Api -Path "/api/admin/prices" -Headers (Get-AdminHeaders)).Json.items |
    Where-Object { $_.id -eq $script:PriceDid } | Select-Object -First 1
  Assert-Equal $script:PriceStart $after.price "harga tidak boleh berubah"
  Assert-Equal $script:PriceStartCompare $after.compare_at "compare_at tidak boleh berubah"
}

Test-Case "harga nol negatif dan desimal ditolak" {
  $zero = Set-PricePatch (Get-AdminHeaders) @{ id = $script:PriceDid; price = 0 }
  Assert-Equal 400 $zero.Status "harga nol"
  Assert-Equal "invalid_price" $zero.Json.error "kode error harga nol"
  $neg = Set-PricePatch (Get-AdminHeaders) @{ id = $script:PriceDid; price = -100 }
  Assert-Equal 400 $neg.Status "harga negatif"
  Assert-Equal "invalid_price" $neg.Json.error "kode error harga negatif"
  $dec = Set-PricePatch (Get-AdminHeaders) @{ id = $script:PriceDid; price = 1500.5 }
  Assert-Equal 400 $dec.Status "harga desimal"
  Assert-Equal "invalid_price" $dec.Json.error "kode error harga desimal"
}

Test-Case "nominal nonaktif ditolak saat order" {
  try {
    $off = Set-PricePatch (Get-AdminHeaders) @{ id = $script:PriceDid; active = 0 }
    Assert-Equal 200 $off.Status "nonaktifkan nominal"
    $r = Invoke-Api -Method POST -Path "/api/orders" -Body (New-PriceOrderBody "88291034")
    Assert-Equal 400 $r.Status "order nominal nonaktif"
    Assert-Equal "invalid_denomination" $r.Json.error "kode error nominal nonaktif"
  } finally {
    Set-PricePatch (Get-AdminHeaders) @{ id = $script:PriceDid; active = [int]$script:PriceProbe.active } | Out-Null
  }
}

Test-Case "order lama tetap memakai harga saat dibuat" {
  $script:OrderA = $null
  $script:OrderB = $null
  try {
    $priceA = $script:PriceStart
    $priceB = $script:PriceStart + 7000
    $createA = Invoke-Api -Method POST -Path "/api/orders" -Body (New-PriceOrderBody "88291034")
    if ($createA.Status -eq 409 -or ($createA.Status -eq 400 -and $createA.Json.error -eq "out_of_stock")) {
      Skip-Case "order lama tetap memakai harga saat dibuat :: stok jatah habis ($($createA.Status) $($createA.Json.error))"
      return
    }
    Assert-Equal 201 $createA.Status "order A dibuat"
    Assert-Equal $priceA $createA.Json.order.subtotal "subtotal order A"
    $script:OrderA = $createA.Json.order.public_id

    $bump = Set-PricePatch (Get-AdminHeaders) @{ id = $script:PriceDid; price = $priceB }
    Assert-Equal 200 $bump.Status "naikkan harga ke B"

    $createB = Invoke-Api -Method POST -Path "/api/orders" -Body (New-PriceOrderBody "88291035")
    if ($createB.Status -eq 409 -or ($createB.Status -eq 400 -and $createB.Json.error -eq "out_of_stock")) {
      Skip-Case "order lama tetap memakai harga saat dibuat :: stok jatah habis ($($createB.Status) $($createB.Json.error))"
      return
    }
    Assert-Equal 201 $createB.Status "order B dibuat"
    Assert-Equal $priceB $createB.Json.order.subtotal "subtotal order B"
    $script:OrderB = $createB.Json.order.public_id

    $getA = Invoke-Api -Path "/api/orders/$($script:OrderA)"
    Assert-Equal 200 $getA.Status "ambil order A"
    Assert-Equal $priceA $getA.Json.order.subtotal "order A harus tetap harga lama"
  } finally {
    Set-PricePatch (Get-AdminHeaders) @{ id = $script:PriceDid; price = $script:PriceStart } | Out-Null
    if ($script:OrderA) { Invoke-Api -Method POST -Path "/api/admin/orders/$($script:OrderA)/cancel" -Headers (Get-AdminHeaders) -Body @{} | Out-Null }
    if ($script:OrderB) { Invoke-Api -Method POST -Path "/api/admin/orders/$($script:OrderB)/cancel" -Headers (Get-AdminHeaders) -Body @{} | Out-Null }
  }
}

Test-Case "satu item invalid membatalkan seluruh patch" {
  $newPrice = $script:PriceStart + 5500
  $res = Set-PricePatch (Get-AdminHeaders) @(
    @{ id = $script:PriceDid; price = $newPrice },
    @{ id = 999999; price = 1000 }
  )
  Assert-Equal 400 $res.Status "patch campuran harus 400"
  Assert-Equal "invalid_denomination" $res.Json.error "kode error patch campuran"
  $after = (Invoke-Api -Path "/api/admin/prices" -Headers (Get-AdminHeaders)).Json.items |
    Where-Object { $_.id -eq $script:PriceDid } | Select-Object -First 1
  Assert-Equal $script:PriceStart $after.price "item valid tidak boleh ikut berubah"
  # Verifikasi akhir: probe kembali ke kondisi awal setelah seluruh blok.
  $final = @((Invoke-Api -Path "/api/admin/prices" -Headers (Get-AdminHeaders)).Json.items | Where-Object { $_.id -eq $script:PriceDid })[0]
  Assert-Equal $script:PriceStart $final.price "harga harus pulih ke nilai awal"
  Assert-Equal $script:PriceStartCompare $final.compare_at "compare_at harus pulih"
  Assert-Equal 1 $final.active "active harus pulih"
}

# ---------------------------------------------------------------- catalog nama
# Semua tes di blok ini menulis ke produksi, jadi setiap tes memulihkan nama asli
# di `finally`. Probe diambil sekali dari respons GET agar tes tidak bergantung
# pada urutan seed.
$script:CatProbe = (Invoke-Api -Path "/api/admin/catalog" -Headers (Get-AdminHeaders)).Json
if ($null -eq $script:CatProbe) { throw "GET /api/admin/catalog tidak mengembalikan JSON" }
$script:CatProduct = @($script:CatProbe.products)[0]
$script:CatCategory = @($script:CatProbe.categories)[0]
$script:CatProdName = [string]$script:CatProduct.name
$script:CatCatName = [string]$script:CatCategory.name

function Set-CatalogPatch($headers, $items) {
  return Invoke-Api -Method PATCH -Path "/api/admin/catalog" -Headers $headers -Body @{ items = @($items) }
}

function Get-CatalogRow([string]$kind, [int]$id) {
  $snap = (Invoke-Api -Path "/api/admin/catalog" -Headers (Get-AdminHeaders)).Json
  $list = if ($kind -eq "category") { @($snap.categories) } else { @($snap.products) }
  return @($list | Where-Object { $_.id -eq $id })[0]
}

Test-Case "admin catalog tanpa token ditolak" {
  $r = Invoke-Api -Path "/api/admin/catalog" -Headers @{}
  Assert-Equal 401 $r.Status "GET harus 401 tanpa token"
  $p = Invoke-Api -Method PATCH -Path "/api/admin/catalog" -Headers @{} -Body @{ items = @(@{ type = "product"; id = 1; name = "x" }) }
  Assert-Equal 401 $p.Status "PATCH harus 401 tanpa token"
}

Test-Case "admin catalog mengembalikan kategori dan produk" {
  $r = Invoke-Api -Path "/api/admin/catalog" -Headers (Get-AdminHeaders)
  Assert-Equal 200 $r.Status "status katalog admin"
  Assert-Equal 5 $r.Json.categories.Count "jumlah kategori"
  Assert-Equal 73 $r.Json.products.Count "jumlah produk"
  Assert-True ($null -eq $r.Json.updated_at -or $r.Json.updated_at -is [string]) "updated_at harus null atau string"
  foreach ($c in $r.Json.categories) {
    Assert-True ($c.id -is [int] -and $c.id -ge 1) "id kategori tidak valid"
    Assert-True ($c.slug.Length -gt 0) "slug kategori kosong"
    Assert-True ($c.name.Length -gt 0) "nama kategori kosong"
    Assert-True ($c.active -eq 0 -or $c.active -eq 1) "active kategori tidak valid"
    Assert-True ($c.product_count -is [int] -and $c.product_count -ge 0) "product_count tidak valid"
    Assert-True ($c.PSObject.Properties.Name -contains "last_change") "last_change wajib ada pada kategori"
  }
  foreach ($p in $r.Json.products) {
    Assert-True ($p.id -is [int] -and $p.id -ge 1) "id produk tidak valid"
    Assert-True ($p.slug.Length -gt 0) "slug produk kosong"
    Assert-True ($p.name.Length -gt 0) "nama produk kosong"
    Assert-True ($p.category_id -is [int] -and $p.category_id -ge 1) "category_id produk tidak valid"
    Assert-True ($p.category_name.Length -gt 0) "category_name produk kosong"
    Assert-True ($p.PSObject.Properties.Name -contains "last_change") "last_change wajib ada pada produk"
  }
}

Test-Case "ganti nama produk tersimpan dan terlihat di catalog publik" {
  $newName = $script:CatProdName + " Uji"
  try {
    $res = Set-CatalogPatch (Get-AdminHeaders) @(@{ type = "product"; id = $script:CatProduct.id; name = $newName })
    Assert-Equal 200 $res.Status "patch nama produk"
    Assert-Equal 1 $res.Json.changed "satu produk berubah"
    $item = @($res.Json.items)[0]
    Assert-Equal $newName $item.name "nama baru di respons"
    Assert-Equal $script:CatProduct.slug $item.slug "slug tidak boleh berubah"
    Assert-Equal $newName $item.last_change.new_name "last_change.new_name"
    Assert-Equal $script:CatProdName $item.last_change.old_name "last_change.old_name"

    $cat = Invoke-Api -Path "/api/catalog"
    $prod = @($cat.Json.categories.products | Where-Object { $_.slug -eq $script:CatProduct.slug })[0]
    Assert-True ($null -ne $prod) "produk hilang dari catalog publik"
    Assert-Equal $newName $prod.name "catalog publik memakai nama baru"
    Assert-Equal $script:CatProduct.slug $prod.slug "slug produk tetap"

    $det = Invoke-Api -Path "/api/products/$($script:CatProduct.slug)"
    Assert-Equal $newName $det.Json.product.name "detail produk memakai nama baru"
  } finally {
    $restore = Set-CatalogPatch (Get-AdminHeaders) @(@{ type = "product"; id = $script:CatProduct.id; name = $script:CatProdName })
    if ($restore.Status -ne 200) { Write-Host "PERINGATAN: pemulihan nama produk gagal ($($restore.Status))" -ForegroundColor Yellow }
  }
  Assert-Equal $script:CatProdName (Get-CatalogRow "product" $script:CatProduct.id).name "nama produk harus pulih"
}

Test-Case "ganti nama kategori tersimpan dan terlihat di produk" {
  $newName = $script:CatCatName + " Uji"
  $target = @($script:CatProbe.products | Where-Object { $_.category_id -eq $script:CatCategory.id })[0]
  try {
    $res = Set-CatalogPatch (Get-AdminHeaders) @(@{ type = "category"; id = $script:CatCategory.id; name = $newName })
    Assert-Equal 200 $res.Status "patch nama kategori"
    Assert-Equal 1 $res.Json.changed "satu kategori berubah"
    Assert-Equal $newName (@($res.Json.items)[0]).name "nama kategori baru di respons"

    $cat = Invoke-Api -Path "/api/catalog"
    $catRow = @($cat.Json.categories | Where-Object { $_.slug -eq $script:CatCategory.slug })[0]
    Assert-Equal $newName $catRow.name "catalog publik memakai nama kategori baru"
    Assert-True ($null -ne $target) "kategori probe harus punya produk"
    $prodRow = @($catRow.products | Where-Object { $_.slug -eq $target.slug })[0]
    Assert-Equal $newName $prodRow.category_name "category_name produk ikut berubah di catalog"
    $det = Invoke-Api -Path "/api/products/$($target.slug)"
    Assert-Equal $newName $det.Json.product.category_name "category_name di detail produk"
  } finally {
    $restore = Set-CatalogPatch (Get-AdminHeaders) @(@{ type = "category"; id = $script:CatCategory.id; name = $script:CatCatName })
    if ($restore.Status -ne 200) { Write-Host "PERINGATAN: pemulihan nama kategori gagal ($($restore.Status))" -ForegroundColor Yellow }
  }
  Assert-Equal $script:CatCatName (Get-CatalogRow "category" $script:CatCategory.id).name "nama kategori harus pulih"
}

Test-Case "nama kosong atau terlalu panjang ditolak" {
  $empty = Set-CatalogPatch (Get-AdminHeaders) @(@{ type = "product"; id = $script:CatProduct.id; name = "   " })
  Assert-Equal 400 $empty.Status "nama kosong"
  Assert-Equal "invalid_name" $empty.Json.error "kode error nama kosong"
  $long = Set-CatalogPatch (Get-AdminHeaders) @(@{ type = "product"; id = $script:CatProduct.id; name = ("A" * 61) })
  Assert-Equal 400 $long.Status "nama 61 karakter"
  Assert-Equal "invalid_name" $long.Json.error "kode error nama panjang"
  Assert-Equal $script:CatProdName (Get-CatalogRow "product" $script:CatProduct.id).name "nama tidak boleh berubah"
}

Test-Case "satu item invalid membatalkan seluruh patch nama" {
  $newName = $script:CatProdName + " Batal"
  $res = Set-CatalogPatch (Get-AdminHeaders) @(
    @{ type = "product"; id = $script:CatProduct.id; name = $newName },
    @{ type = "product"; id = 999999; name = "Tidak Ada" }
  )
  Assert-Equal 400 $res.Status "patch campuran harus 400"
  Assert-Equal "not_found" $res.Json.error "kode error item tidak ditemukan"
  Assert-Equal $script:CatProdName (Get-CatalogRow "product" $script:CatProduct.id).name "item valid tidak boleh ikut berubah"
}

Test-Case "nama tanpa perubahan tidak menulis riwayat" {
  $before = @((Invoke-Api -Path "/api/admin/catalog" -Headers (Get-AdminHeaders)).Json.products |
    Where-Object { $_.id -eq $script:CatProduct.id })[0]
  $res = Set-CatalogPatch (Get-AdminHeaders) @(@{ type = "product"; id = $script:CatProduct.id; name = $script:CatProdName })
  Assert-Equal 200 $res.Status "patch nama sama"
  Assert-Equal 0 $res.Json.changed "tidak ada perubahan harus changed=0"
  $after = (Get-CatalogRow "product" $script:CatProduct.id)
  Assert-Equal $script:CatProdName $after.name "nama tetap"
  $beforeAt = if ($before.last_change) { [string]$before.last_change.changed_at } else { "" }
  $afterAt = if ($after.last_change) { [string]$after.last_change.changed_at } else { "" }
  Assert-Equal $beforeAt $afterAt "last_change tidak boleh bertambah"
}

Test-Case "tipe dan id item yang salah ditolak" {
  $badType = Set-CatalogPatch (Get-AdminHeaders) @(@{ type = "sku"; id = $script:CatProduct.id; name = "X" })
  Assert-Equal 400 $badType.Status "tipe tidak dikenal"
  Assert-Equal "invalid_type" $badType.Json.error "kode error tipe"
  foreach ($badId in @(0, -1, 1.5, "3", $null)) {
    $bad = Set-CatalogPatch (Get-AdminHeaders) @(@{ type = "product"; id = $badId; name = "X" })
    Assert-Equal 400 $bad.Status "id tidak valid: $badId"
    Assert-Equal "invalid_id" $bad.Json.error "kode error id ($badId)"
  }
  $noType = Set-CatalogPatch (Get-AdminHeaders) @(@{ id = $script:CatProduct.id; name = "X" })
  Assert-Equal "invalid_type" $noType.Json.error "tipe hilang"
  Assert-Equal $script:CatProdName (Get-CatalogRow "product" $script:CatProduct.id).name "nama tidak boleh berubah"
}

Test-Case "nama non-string ditolak" {
  foreach ($bad in @(1, 2.5, $true, @("a", "b"))) {
    $res = Set-CatalogPatch (Get-AdminHeaders) @(@{ type = "product"; id = $script:CatProduct.id; name = $bad })
    Assert-Equal 400 $res.Status "nama non-string: $bad"
    Assert-Equal "invalid_name" $res.Json.error "kode error nama non-string ($bad)"
  }
  $missing = Invoke-Api -Method PATCH -Path "/api/admin/catalog" -Headers (Get-AdminHeaders) -Body @{ items = @(@{ type = "product"; id = $script:CatProduct.id }) }
  Assert-Equal 400 $missing.Status "nama hilang"
  Assert-Equal "invalid_name" $missing.Json.error "kode error nama hilang"
  Assert-Equal $script:CatProdName (Get-CatalogRow "product" $script:CatProduct.id).name "nama tidak boleh berubah"
}

Test-Case "item ganda ditolak" {
  $dup = Set-CatalogPatch (Get-AdminHeaders) @(
    @{ type = "product"; id = $script:CatProduct.id; name = "Satu" },
    @{ type = "product"; id = $script:CatProduct.id; name = "Dua" }
  )
  Assert-Equal 400 $dup.Status "duplikat produk"
  Assert-Equal "duplicate_item" $dup.Json.error "kode error duplikat"
  Assert-Equal $script:CatProdName (Get-CatalogRow "product" $script:CatProduct.id).name "nama tidak boleh berubah"
}

Test-Case "items kosong atau bukan array ditolak" {
  $empty = Set-CatalogPatch (Get-AdminHeaders) @()
  Assert-Equal 400 $empty.Status "items kosong"
  Assert-Equal "invalid_items" $empty.Json.error "kode error items kosong"
  $notArray = Invoke-Api -Method PATCH -Path "/api/admin/catalog" -Headers (Get-AdminHeaders) -Body @{ items = "produk" }
  Assert-Equal 400 $notArray.Status "items bukan array"
  Assert-Equal "invalid_items" $notArray.Json.error "kode error items bukan array"
  $noItems = Invoke-Api -Method PATCH -Path "/api/admin/catalog" -Headers (Get-AdminHeaders) -Body @{ foo = 1 }
  Assert-Equal 400 $noItems.Status "items tidak ada"
  Assert-Equal "invalid_items" $noItems.Json.error "kode error items tidak ada"
}

Test-Case "lebih dari 50 item ditolak" {
  $items = @()
  for ($i = 0; $i -lt 51; $i++) { $items += @{ type = "product"; id = 1; name = "Nama $i" } }
  $res = Set-CatalogPatch (Get-AdminHeaders) $items
  Assert-Equal 400 $res.Status "51 item"
  # Validasi urut: duplikat id juga ada, tapi too_many_items harus diperiksa lebih dulu.
  Assert-Equal "too_many_items" $res.Json.error "kode error jumlah item"
}

Test-Case "riwayat nama terbaru bisa dibaca" {
  $noToken = Invoke-Api -Path "/api/admin/catalog/history" -Headers @{}
  Assert-Equal 401 $noToken.Status "riwayat tanpa token"

  $newName = $script:CatProdName + " Riwayat"
  try {
    $res = Set-CatalogPatch (Get-AdminHeaders) @(@{ type = "product"; id = $script:CatProduct.id; name = $newName })
    Assert-Equal 200 $res.Status "patch untuk riwayat"
    $hist = Invoke-Api -Path "/api/admin/catalog/history?limit=10" -Headers (Get-AdminHeaders)
    Assert-Equal 200 $hist.Status "status riwayat"
    $rows = @($hist.Json.items)
    Assert-True ($rows.Count -ge 1) "riwayat harus berisi minimal satu baris"
    Assert-True ($rows.Count -le 10) "limit 10 harus dipatuhi"
    $top = $rows[0]
    Assert-Equal "product" $top.entity_type "entitas teratas"
    Assert-Equal $script:CatProduct.id $top.entity_id "id entitas teratas"
    Assert-Equal $script:CatProduct.slug $top.slug "slug teratas"
    Assert-Equal $script:CatProdName $top.old_name "old_name teratas"
    Assert-Equal $newName $top.new_name "new_name teratas"
    Assert-Equal "admin" $top.source "source teratas"
    Assert-True ([string]$top.changed_at -match "^\d{4}-\d{2}-\d{2}T") "changed_at harus ISO"
  } finally {
    $restore = Set-CatalogPatch (Get-AdminHeaders) @(@{ type = "product"; id = $script:CatProduct.id; name = $script:CatProdName })
    if ($restore.Status -ne 200) { Write-Host "PERINGATAN: pemulihan nama produk gagal ($($restore.Status))" -ForegroundColor Yellow }
  }
  Assert-Equal $script:CatProdName (Get-CatalogRow "product" $script:CatProduct.id).name "nama produk harus pulih"
}

Write-Host ""
Write-Host "Result: $($script:Pass) passed, $($script:Fail) failed" -ForegroundColor $(if ($script:Fail -eq 0) { "Green" } else { "Red" })
if ($script:Fail -gt 0) {
  Write-Host ""
  Write-Host "Failures:" -ForegroundColor Red
  $script:Failures | ForEach-Object { Write-Host " - $_" -ForegroundColor Red }
  exit 1
}
exit 0
