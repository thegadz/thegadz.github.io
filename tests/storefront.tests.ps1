param(
  [string]$ApiBase = $env:API_BASE,
  [string]$Root = ""
)

$ErrorActionPreference = "Stop"
if (-not $Root) { $Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path) }
if (-not $ApiBase) { $ApiBase = "https://gadzstore-api.blueicespeed.workers.dev" }
$ApiBase = $ApiBase.TrimEnd('/')

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
function Assert-True([bool]$condition, [string]$message) {
  if (-not $condition) { throw $message }
}
function Assert-Match([string]$pattern, [string]$value, [string]$message) {
  if ($value -notmatch $pattern) { throw "$message (does not match $pattern)" }
}
function Test-Case([string]$name, [scriptblock]$body) {
  try {
    & $body
    Write-Pass $name
  } catch {
    Write-Fail $name $_.Exception.Message
  }
}
function Invoke-Catalog {
  $res = Invoke-WebRequest -Uri "$ApiBase/api/catalog" -UseBasicParsing -TimeoutSec 45
  if ([int]$res.StatusCode -ne 200) { throw "catalog HTTP $($res.StatusCode)" }
  return $res.Content | ConvertFrom-Json
}

$expected = [ordered]@{
  "Top Up Game" = @(
    "Mobile Legends Diamonds", "Free Fire Diamonds", "PUBG Mobile UC",
    "Higgs Games Island Coins", "Magic Chess: Go Go", "Delta Force - Garena",
    "Ragnarok: The New World (GNJOY Link)", "Valorant Points", "Arena Breakout Bonds",
    "Honor of Kings Tokens", "Delta Force - Steam", "Where Winds Meet",
    "Whiteout Survival Frost Stars", "Kings Choice Diamonds", "Point Blank Cash",
    "Metal Slug: Awakening", "Blood Strike Gold", "Ragnarok M Eternal Love",
    "Crystal of Atlan", "Wuthering Waves"
  )
  "Top Up Live Apps" = @(
    "Poppo Live Coins", "Bigo Live Diamonds", "Zepeto Zems", "Sugo Voice Chat Party",
    "Mico Live Coins", "LivU Coin", "Telegram Stars", "imo International Calls and Chat",
    "Mango Live Diamonds", "Nimo TV Diamonds", "Chamet", "WeSing Kcoins",
    "Dreamlike Diamonds", "Lita Coins", "Kumu Livestream", "YoHo: Group Voice Chat",
    "HAGO Diamonds", "StarMaker Karaoke Coins", "Party Star", "Xena Group Voice Party"
  )
  "Voucher" = @(
    "Steam Vouchers", "Google Play Voucher", "PlayStation Network (PSN)", "Roblox Robux",
    "Vidio", "Vision+ Voucher", "Dramabox Powered by Google Play", "FolaPlay", "Token PLN",
    "Binance Gift Card", "PC Game Pass", "Voucher Valorant", "Fortnite V Bucks",
    "Twitch Gift Cards", "Monster Hunter Wilds CD Keys - SEA", "XBOX Gift Cards",
    "TikTok Live Gift Card Koin", "Garena Shell Voucher", "Minecraft Minecoins Voucher",
    "UniPin Gift Card"
  )
  "Pulsa" = @("Indosat", "Tri", "Telkomsel", "XL", "Axis", "Smartfren")
  "E-Money" = @("DANA", "OVO", "LinkAja", "Gopay", "ShopeePay", "MAXIM", "Sakuku")
}

Test-Case "catalog matches Tokogame menu: 5 categories, 73 products" {
  $catalog = Invoke-Catalog
  Assert-Equal 5 $catalog.categories.Count "category count"
  $names = @($catalog.categories | ForEach-Object { $_.name })
  $expectedNames = @($expected.Keys)
  Assert-Equal ($expectedNames -join "|") ($names -join "|") "category order"
  $total = 0
  foreach ($category in $catalog.categories) {
    $total += $category.products.Count
  }
  Assert-Equal 73 $total "product total"
}

Test-Case "each category has the exact Tokogame product order" {
  $catalog = Invoke-Catalog
  foreach ($category in $catalog.categories) {
    $want = @($expected[$category.name])
    $got = @($category.products | ForEach-Object { $_.name })
    Assert-Equal ($want -join "|") ($got -join "|") "products in $($category.name)"
  }
}

Test-Case "every product has 3-5 priced denominations" {
  $catalog = Invoke-Catalog
  foreach ($category in $catalog.categories) {
    foreach ($product in $category.products) {
      Assert-True ($product.denomination_count -ge 3 -and $product.denomination_count -le 5) "$($product.slug) has $($product.denomination_count) denominations"
      Assert-True ([int]$product.min_price -gt 0) "$($product.slug) has no min_price"
    }
  }
}

Test-Case "storefront shell uses fixed Tokogame-style header, news strip, search" {
  $html = Get-Content (Join-Path $Root "index.html") -Raw
  Assert-Match 'id="menuBtn"' $html "hamburger menu"
  Assert-Match 'class="news-strip"' $html "news strip"
  Assert-Match 'id="searchForm"' $html "search form"
  Assert-Match 'id="catNav"' $html "drawer category nav"
  Assert-True ($html -notmatch 'class="hero"') "hero must be removed"
  Assert-True ($html -notmatch 'class="promo-strip"') "old promo strip must be removed"
}

Test-Case "home product cards are icon-and-name only, 5 columns" {
  $js = Get-Content (Join-Path $Root "store.js") -Raw
  $css = Get-Content (Join-Path $Root "store.css") -Raw
  Assert-True ($js -notmatch 'product-price') "cards must not render prices"
  Assert-True ($js -notmatch 'product-meta') "cards must not render metadata"
  Assert-Match 'section-cta' $js "bottom Lihat Semua button"
  Assert-Match '#05ce78' $css "Tokogame green accent"
  Assert-Match 'repeat\(5, 142px\)' $css "five 142px product columns"
}

Test-Case "pending order shows the real GoPay standee QR with a manual-amount note" {
  $js = Get-Content (Join-Path $Root "store.js") -Raw
  Assert-Match 'assets/qris/gopay-standee\.png' $js "standee QR asset path"
  Assert-Match 'qr-note' $js "manual-amount notice"
  Assert-Match 'qr-code-image' $js "image QR class"
  $standee = Join-Path $Root "assets/qris/gopay-standee.png"
  Assert-True (Test-Path $standee) "standee QR file missing at assets/qris/gopay-standee.png"
  $len = (Get-Item $standee).Length
  Assert-True ($len -gt 1000 -and $len -lt 350000) "standee QR size out of range ($len bytes)"
}

Test-Case "storefront keeps fee rows hidden-friendly when fee_percent is 0" {
  $js = Get-Content (Join-Path $Root "store.js") -Raw
  Assert-Match 'feePercent\(\) > 0' $js "fee row must be conditional on a non-zero fee"
}

Test-Case "product artwork layers over the gradient tile and falls back when missing" {
  $js = Get-Content (Join-Path $Root "store.js") -Raw
  $css = Get-Content (Join-Path $Root "store.css") -Raw
  Assert-Match 'PRODUCT_IMAGE_DIR = "assets/products/"' $js "artwork directory constant"
  Assert-Match 'onerror="this\.remove\(\)"' $js "broken image must remove itself"
  Assert-Match 'function productArt\(' $js "shared artwork helper"
  # Cards, the product hero and the checkout summary all use the helper.
  Assert-True (([regex]::Matches($js, 'productArt\(product')).Count -ge 3) "productArt must render cards, hero and summary icon"
  Assert-Match '\.product-thumb img,\s*\.product-hero-icon img,\s*\.summary-product-icon img' $css "artwork must be reachable from all three tiles"
  Assert-Match 'object-fit: cover' $css "artwork must fill its tile"
  Assert-Match '\.summary-product-icon \{[^}]*position: relative' $css "summary icon needs a positioned ancestor for the image"

  # The live API always exposes the image field, even while it is still empty.
  $catalog = Invoke-Catalog
  $missing = @()
  foreach ($category in $catalog.categories) {
    foreach ($product in $category.products) {
      if (-not ($product.PSObject.Properties.Name -contains "image")) { $missing += $product.slug }
      elseif ([string]$product.image -ne "") {
        Assert-Match '^[^\\/:]+\.(png|jpg|jpeg|webp)$' ([string]$product.image).ToLowerInvariant() "$($product.slug) image must be a bare filename"
      }
    }
  }
  Assert-Equal 0 $missing.Count "products without an image field (e.g. $($missing -join ', '))"
}

Write-Host ""
Write-Host "Result: $script:Pass passed, $script:Fail failed" -ForegroundColor $(if ($script:Fail) { "Red" } else { "Green" })
if ($script:Failures.Count) {
  $script:Failures | ForEach-Object { Write-Host " - $_" -ForegroundColor DarkRed }
  exit 1
}
exit 0
