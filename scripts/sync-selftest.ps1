<#
  Nova sync receiver - self test
  ------------------------------
  Exercises every layer of /api/sync/in from the outside, so "is it my end or
  theirs" stops being a matter of opinion.

  The token is a PARAMETER, never hard-coded. This file lives in the repo and
  the repo is on GitHub; a token pasted in here is a token published.

  Usage:
      .\sync-selftest.ps1 -Token "the-shared-secret"
      .\sync-selftest.ps1 -Token "..." -Slug pulsar -Header auth
      .\sync-selftest.ps1 -Token "..." -SkipWrites        # read-only checks

  Every write uses autonum values in the 888xxx range and dataTarget
  "selftest", so its rows are obvious in the event log and easy to ignore.
#>

param(
  [Parameter(Mandatory = $true)][string]$Token,
  [string]$BaseUrl = "https://www.popalockar.com",
  [string]$Slug    = "pulsar",
  [string]$Header  = "auth",
  [switch]$SkipWrites
)

$ErrorActionPreference = "Continue"
$Url  = "$BaseUrl/api/sync/in/$Slug"
$pass = 0
$fail = 0

function Show([string]$name, [bool]$ok, [string]$detail) {
  if ($ok) { $script:pass++; Write-Host ("  PASS  " + $name) -ForegroundColor Green }
  else     { $script:fail++; Write-Host ("  FAIL  " + $name) -ForegroundColor Red }
  if ($detail) { Write-Host ("        " + $detail) -ForegroundColor DarkGray }
}

# Returns @{ Status = <int>; Body = <string> } for any outcome, including
# failures - PowerShell throws on 4xx/5xx and we want the code, not the throw.
function Send([string]$method, [string]$body) {
  $headers = @{ $Header = $Token }
  try {
    if ($method -eq "GET") {
      $r = Invoke-WebRequest -Uri $Url -Method GET -UseBasicParsing -TimeoutSec 30
    } else {
      $r = Invoke-WebRequest -Uri $Url -Method POST -Headers $headers -ContentType "application/json" -Body $body -UseBasicParsing -TimeoutSec 60
    }
    return @{ Status = [int]$r.StatusCode; Body = $r.Content }
  } catch {
    $code = 0
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    return @{ Status = $code; Body = "$($_.ErrorDetails.Message)" }
  }
}

function SendRaw([string]$url, [hashtable]$headers, [string]$body) {
  try {
    $r = Invoke-WebRequest -Uri $url -Method POST -Headers $headers -ContentType "application/json" -Body $body -UseBasicParsing -TimeoutSec 60
    return @{ Status = [int]$r.StatusCode; Body = $r.Content }
  } catch {
    $code = 0
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    return @{ Status = $code; Body = "$($_.ErrorDetails.Message)" }
  }
}

$stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddHHmmss")
Write-Host ""
Write-Host "Nova sync self test" -ForegroundColor Cyan
Write-Host "  $Url"
Write-Host "  header: $Header    run id: $stamp"
Write-Host ""

# --------------------------------------------------------------- reachability
Write-Host "REACHABILITY" -ForegroundColor Cyan
try {
  $dns = [System.Net.Dns]::GetHostAddresses(([uri]$BaseUrl).Host)
  Show "DNS resolves" $true (($dns | ForEach-Object { $_.IPAddressToString }) -join ", ")
} catch {
  Show "DNS resolves" $false $_.Exception.Message
}

$g = Send "GET" $null
Show "endpoint answers a GET" ($g.Status -eq 200) "HTTP $($g.Status)"
if ($g.Status -eq 0) {
  Write-Host ""
  Write-Host "  Could not reach the host at all. Nothing below will work." -ForegroundColor Yellow
  Write-Host "  That is a network / DNS / TLS problem, not an application one." -ForegroundColor Yellow
  Write-Host ""
  exit 1
}

if ($SkipWrites) {
  Write-Host ""
  Write-Host "Read-only run. $pass passed, $fail failed." -ForegroundColor Cyan
  exit 0
}

# ---------------------------------------------------------------------- auth
Write-Host ""
Write-Host "AUTH" -ForegroundColor Cyan

$bad = SendRaw $Url @{ $Header = "definitely-not-the-token" } '{"autonum":"888901","dataHeader":9999}'
Show "a wrong token is refused" ($bad.Status -eq 401) "HTTP $($bad.Status) - should also appear in the rejections panel"

$none = SendRaw $Url @{} '{"autonum":"888902","dataHeader":9999}'
Show "no token at all is refused" ($none.Status -eq 401) "HTTP $($none.Status)"

$wrongUrl = SendRaw "$BaseUrl/api/sync/in/$Slug-typo" @{ $Header = $Token } '{"autonum":"888903"}'
Show "an unknown slug is refused" ($wrongUrl.Status -eq 401) "HTTP $($wrongUrl.Status) - and reveals nothing about which sources exist"

# ------------------------------------------------------------------- single
Write-Host ""
Write-Host "SINGLE RECORD" -ForegroundColor Cyan

$one = Send "POST" ('{"autonum":"888' + $stamp.Substring(8) + '01","gmtStamp":"' +
  (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") +
  '","dataHeader":5010,"dataTarget":"selftest","locationID":"3","targetID":"0"}')
Show "a valid single record is accepted" ($one.Status -eq 200 -or $one.Status -eq 202) "HTTP $($one.Status)  $($one.Body)"

$dupe = Send "POST" ('{"autonum":"888' + $stamp.Substring(8) + '01","dataHeader":5010,"dataTarget":"selftest"}')
if ($dupe.Body -match '"duplicate":true') {
  Show "resending the same id is a safe no-op" $true "HTTP $($dupe.Status) - duplicate checking is ON for this source"
} else {
  Show "resend stored again" $true "HTTP $($dupe.Status) - duplicate checking is OFF for this source (expected right now)"
}

# -------------------------------------------------------------------- arrays
Write-Host ""
Write-Host "ARRAYS - what Pulsar actually sends" -ForegroundColor Cyan

$arr = '[{"autonum":"888' + $stamp.Substring(8) + '10","dataHeader":5000,"dataTarget":"selftest"},' +
       '{"autonum":"888' + $stamp.Substring(8) + '11","dataHeader":5010,"dataTarget":"selftest"}]'
$a = Send "POST" $arr
Show "a 2-record array is accepted" ($a.Status -eq 200 -or $a.Status -eq 202) "HTTP $($a.Status)  $($a.Body)"

# The one that used to time out.
$items = @()
for ($i = 0; $i -lt 100; $i++) {
  $items += '{"autonum":"888' + $stamp.Substring(8) + ('{0:D3}' -f ($i + 100)) +
            '","dataHeader":' + (5000 + ($i % 5)) + ',"dataTarget":"selftest","locationID":"3"}'
}
$bulk = "[" + ($items -join ",") + "]"
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$b = Send "POST" $bulk
$sw.Stop()
Show "a 100-record batch is accepted" ($b.Status -eq 200 -or $b.Status -eq 202) "HTTP $($b.Status) in $($sw.ElapsedMilliseconds)ms  $($b.Body)"
Show "the batch answered quickly" ($sw.ElapsedMilliseconds -lt 10000) "$($sw.ElapsedMilliseconds)ms - this is the check that catches the timeout bug coming back"

# ---------------------------------------------------------------- bad bodies
Write-Host ""
Write-Host "MALFORMED INPUT" -ForegroundColor Cyan

$bj = Send "POST" "this is not json"
Show "malformed JSON is refused" ($bj.Status -eq 400) "HTTP $($bj.Status)"

$scalar = Send "POST" '"just a string"'
Show "a bare JSON string is refused" ($scalar.Status -eq 400) "HTTP $($scalar.Status)"

$empty = Send "POST" "[]"
Show "an empty array is accepted cleanly" ($empty.Status -eq 200 -or $empty.Status -eq 202) "HTTP $($empty.Status)  $($empty.Body)"

# -------------------------------------------------------------------- result
Write-Host ""
if ($fail -eq 0) {
  Write-Host "$pass passed, 0 failed." -ForegroundColor Green
  Write-Host ""
  Write-Host "Nova is accepting traffic correctly on every path tested." -ForegroundColor Green
  Write-Host "If a partner still reports sending and you see nothing, the problem is" -ForegroundColor Green
  Write-Host "between their server and this URL - not in the receiver." -ForegroundColor Green
} else {
  Write-Host "$pass passed, $fail FAILED." -ForegroundColor Red
}
Write-Host ""
Write-Host "Now check Settings > Data Sync:" -ForegroundColor Cyan
Write-Host "  Events      - selftest rows, newest first"
Write-Host "  Traffic     - Delivered should have jumped by about 105"
Write-Host "  Rejections  - should show 3 new entries from THIS machine's IP"
Write-Host ""
