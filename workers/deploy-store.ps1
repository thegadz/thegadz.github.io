# Deploy the TheGadz Store API to Cloudflare Workers + D1 using the HTTP API.
# Usage:
#   powershell -ExecutionPolicy Bypass -File workers\deploy-store.ps1
#   powershell -ExecutionPolicy Bypass -File workers\deploy-store.ps1 -SkipSeed
param(
  [switch]$SkipSeed
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Net.Http

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$envFile = Join-Path $root ".env"
$workerFile = Join-Path $root "worker\store-worker.js"
$schemaFile = Join-Path $root "db\schema.sql"
$seedFile = Join-Path $root "db\seed.sql"

if (-not (Test-Path $envFile)) { throw ".env not found at $envFile" }
$lines = [System.IO.File]::ReadAllLines($envFile, [System.Text.Encoding]::UTF8)
function Get-Env([string]$name, [string]$fallback = "") {
  $value = ($lines | Where-Object { $_ -match "^\s*$name\s*=" }) -replace '^\s*[^=]+\s*=\s*', ''
  $value = $value.Trim().Trim('"').Trim("'")
  if ([string]::IsNullOrEmpty($value)) { return $fallback }
  return $value
}

$token = Get-Env "CLOUDFLARE_API_TOKEN"
$account = Get-Env "CLOUDFLARE_ACCOUNT_ID"
$dbId = Get-Env "D1_DATABASE_ID"
$scriptName = Get-Env "WORKER_NAME" "gadzstore-api"
$adminToken = Get-Env "ADMIN_TOKEN"
$webhookSecret = Get-Env "QRIS_WEBHOOK_SECRET"
$qrisStatic = Get-Env "QRIS_STATIC_PAYLOAD" ""
$qrisImage = Get-Env "QRIS_IMAGE" "assets/qris/gopay-standee.png"
$feePercent = Get-Env "QRIS_FEE_PERCENT" "0.7"
$orderTtl = Get-Env "ORDER_TTL_SECONDS" "900"
$paymentHold = Get-Env "PAYMENT_HOLD_SECONDS" "86400"
$maxProof = Get-Env "MAX_PROOF_BYTES" "1200000"
$demoMode = Get-Env "DEMO_MODE" "1"
$storeName = Get-Env "STORE_NAME" "TheGadz Store"
$allowedOrigins = Get-Env "ALLOWED_ORIGINS" "https://thegadz.github.io"

if (-not $token -or -not $account -or -not $dbId) {
  throw "CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and D1_DATABASE_ID are required in .env"
}
if (-not $adminToken) { throw "ADMIN_TOKEN is required in .env" }
if (-not $webhookSecret) { throw "QRIS_WEBHOOK_SECRET is required in .env" }

$base = "https://api.cloudflare.com/client/v4/accounts/$account"
$headers = @{ Authorization = "Bearer $token" }

function Invoke-D1([string]$sql) {
  $payload = @{ sql = $sql } | ConvertTo-Json -Compress
  $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
  $response = Invoke-RestMethod -Uri "$base/d1/database/$dbId/query" -Method Post -Headers $headers -Body $bodyBytes -ContentType "application/json; charset=utf-8" -TimeoutSec 60
  if (-not $response.success) {
    $detail = ($response.errors | ConvertTo-Json -Depth 6 -Compress)
    throw "D1 query failed: $detail`nSQL: $($sql.Substring(0, [Math]::Min(200, $sql.Length)))"
  }
  return $response
}

function Get-SqlStatements([string]$path) {
  $statements = New-Object System.Collections.Generic.List[string]
  $buffer = New-Object System.Text.StringBuilder
  foreach ($line in [System.IO.File]::ReadAllLines($path, [System.Text.Encoding]::UTF8)) {
    $trim = $line.Trim()
    if ($trim -eq "" -or $trim.StartsWith("--")) { continue }
    [void]$buffer.AppendLine($line)
    if ($trim.EndsWith(";")) {
      $sql = $buffer.ToString().Trim()
      $sql = $sql.Substring(0, $sql.Length - 1).Trim()
      if ($sql.Length -gt 0) { $statements.Add($sql) }
      [void]$buffer.Clear()
    }
  }
  if ($buffer.Length -gt 0) {
    $sql = $buffer.ToString().Trim()
    if ($sql.Length -gt 0) { $statements.Add($sql) }
  }
  return $statements
}

Write-Host "Applying schema..." -ForegroundColor Cyan
$schemaStatements = Get-SqlStatements $schemaFile
foreach ($sql in $schemaStatements) { [void](Invoke-D1 $sql) }
Write-Host "  $($schemaStatements.Count) statements applied" -ForegroundColor Green

# ADD COLUMN migrations: SQLite has no IF NOT EXISTS for columns, so inspect first.
$migrations = [ordered]@{
  orders   = [ordered]@{
    proof_data          = "TEXT"
    proof_mime          = "TEXT NOT NULL DEFAULT ''"
    proof_size          = "INTEGER NOT NULL DEFAULT 0"
    proof_sender        = "TEXT NOT NULL DEFAULT ''"
    proof_note          = "TEXT NOT NULL DEFAULT ''"
    proof_uploaded_at   = "TEXT"
    proof_rejected_at   = "TEXT"
    proof_reject_reason = "TEXT NOT NULL DEFAULT ''"
  }
  products = [ordered]@{
    image = "TEXT NOT NULL DEFAULT ''"
  }
}
foreach ($table in $migrations.Keys) {
  $columns = $migrations[$table]
  Write-Host "Checking $table columns..." -ForegroundColor Cyan
  $info = Invoke-D1 "PRAGMA table_info($table)"
  $existing = @($info.result[0].results | ForEach-Object { $_.name })
  $added = 0
  foreach ($name in $columns.Keys) {
    if ($existing -contains $name) { continue }
    [void](Invoke-D1 "ALTER TABLE $table ADD COLUMN $name $($columns[$name])")
    Write-Host "  added column $name" -ForegroundColor DarkGray
    $added++
  }
  Write-Host "  $added column(s) added, $($columns.Count - $added) already present" -ForegroundColor Green
}

if (-not $SkipSeed) {
  Write-Host "Applying catalog seed..." -ForegroundColor Cyan
  $seedStatements = Get-SqlStatements $seedFile
  $i = 0
  foreach ($sql in $seedStatements) {
    [void](Invoke-D1 $sql)
    $i++
    if ($i % 20 -eq 0) { Write-Host "  $i / $($seedStatements.Count)" -ForegroundColor DarkGray }
  }
  Write-Host "  $($seedStatements.Count) statements applied" -ForegroundColor Green
}

Write-Host "Uploading worker $scriptName..." -ForegroundColor Cyan
$bindings = @(
  @{ type = "d1"; name = "DB"; id = $dbId },
  @{ type = "secret_text"; name = "ADMIN_TOKEN"; text = $adminToken },
  @{ type = "secret_text"; name = "QRIS_WEBHOOK_SECRET"; text = $webhookSecret },
  @{ type = "plain_text"; name = "QRIS_FEE_PERCENT"; text = $feePercent },
  @{ type = "plain_text"; name = "ORDER_TTL_SECONDS"; text = $orderTtl },
  @{ type = "plain_text"; name = "PAYMENT_HOLD_SECONDS"; text = $paymentHold },
  @{ type = "plain_text"; name = "MAX_PROOF_BYTES"; text = $maxProof },
  @{ type = "plain_text"; name = "DEMO_MODE"; text = $demoMode },
  @{ type = "plain_text"; name = "STORE_NAME"; text = $storeName },
  @{ type = "plain_text"; name = "ALLOWED_ORIGINS"; text = $allowedOrigins },
  @{ type = "plain_text"; name = "QRIS_IMAGE"; text = $qrisImage }
)
if ($qrisStatic) {
  $bindings += @{ type = "secret_text"; name = "QRIS_STATIC_PAYLOAD"; text = $qrisStatic }
}

$metadata = @{
  main_module = "worker.js"
  compatibility_date = "2026-11-01"
  bindings = $bindings
} | ConvertTo-Json -Depth 10 -Compress

$workerCode = [System.IO.File]::ReadAllText($workerFile)
$http = New-Object System.Net.Http.HttpClient
$http.DefaultRequestHeaders.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", $token)
$form = New-Object System.Net.Http.MultipartFormDataContent
$metaContent = New-Object System.Net.Http.StringContent($metadata, [Text.Encoding]::UTF8, "application/json")
$form.Add($metaContent, "metadata")
$scriptContent = New-Object System.Net.Http.StringContent($workerCode, [Text.Encoding]::UTF8, "application/javascript+module")
$form.Add($scriptContent, "worker.js", "worker.js")

$upload = $http.PutAsync("$base/workers/scripts/$scriptName", $form).Result
$uploadBody = $upload.Content.ReadAsStringAsync().Result
if (-not $upload.IsSuccessStatusCode) {
  throw "Worker upload failed HTTP $([int]$upload.StatusCode): $uploadBody"
}

Write-Host "Enabling workers.dev subdomain..." -ForegroundColor Cyan
try {
  [void](Invoke-RestMethod -Uri "$base/workers/scripts/$scriptName/subdomain" -Method Post -Headers $headers -ContentType "application/json" -Body '{"enabled":true}' -TimeoutSec 30)
} catch {
  Write-Host "  subdomain already enabled or unavailable: $($_.Exception.Message)" -ForegroundColor Yellow
}
$subdomain = (Invoke-RestMethod -Uri "$base/workers/subdomain" -Headers $headers -TimeoutSec 30).result.subdomain
$url = "https://$scriptName.$subdomain.workers.dev"

Write-Host ""
Write-Host "Deployed: $url" -ForegroundColor Green
Write-Host "Admin:    $url/admin" -ForegroundColor Green
Write-Host "Health:   $url/api/health" -ForegroundColor Green
Write-Host ""
$qrisLabel = if ($qrisStatic) { "static" } elseif ($qrisImage) { "image" } else { "demo" }
Write-Host "QRIS mode: $qrisLabel ($qrisImage) | demo flag: $demoMode | TTL: ${orderTtl}s" -ForegroundColor DarkGray
