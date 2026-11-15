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
  $uri = "$ApiBase$Path"
  $params = @{
    Uri = $uri
    Method = $Method
    Headers = $Headers
    TimeoutSec = 45
    UseBasicParsing = $true
  }
  if (-not [string]::IsNullOrEmpty($RawBody)) {
    $params.Body = $RawBody
    $params.ContentType = "application/json"
  } elseif ($null -ne $Body) {
    $params.Body = ($Body | ConvertTo-Json -Depth 10 -Compress)
    $params.ContentType = "application/json"
  }
  try {
    $res = Invoke-WebRequest @params
    $json = $null
    try { $json = $res.Content | ConvertFrom-Json } catch {}
    return [pscustomobject]@{ Status = [int]$res.StatusCode; Json = $json; Raw = $res.Content }
  } catch [System.Net.WebException] {
    $resp = $_.Exception.Response
    $code = 0
    if ($resp) { $code = [int]$resp.StatusCode }
    $raw = ""
    if ($resp) {
      $stream = $resp.GetResponseStream()
      if ($stream) {
        $reader = New-Object System.IO.StreamReader($stream)
        $raw = $reader.ReadToEnd()
      }
    }
    $json = $null
    try { $json = $raw | ConvertFrom-Json } catch {}
    return [pscustomobject]@{ Status = $code; Json = $json; Raw = $raw }
  } catch {
    throw "Request failed: $Method $uri :: $($_.Exception.Message)"
  }
}

function Test-Case([string]$name, [scriptblock]$body) {
  try {
    & $body
    Write-Pass $name
  } catch {
    Write-Fail $name $_.Exception.Message
  }
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
  Assert-True ($r.Json.qris.mode -in @("demo", "static")) "qris mode invalid"
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
  Assert-True ($r.Json.order.qr_payload.Length -gt 10) "qr payload missing"
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

Write-Host ""
Write-Host "Result: $($script:Pass) passed, $($script:Fail) failed" -ForegroundColor $(if ($script:Fail -eq 0) { "Green" } else { "Red" })
if ($script:Fail -gt 0) {
  Write-Host ""
  Write-Host "Failures:" -ForegroundColor Red
  $script:Failures | ForEach-Object { Write-Host " - $_" -ForegroundColor Red }
  exit 1
}
exit 0
