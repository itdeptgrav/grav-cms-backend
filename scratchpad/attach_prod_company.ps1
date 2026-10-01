# Attach every unattached company to the organisation, ON PRODUCTION, through
# the API. No database connection string needed.
#
#   powershell -ExecutionPolicy Bypass -File scratchpad\attach_prod_company.ps1 -Email soumyapraharaj.grav@gmail.com -Password 12345678
#
# Signs in, upgrades to an accounting session, lists the companies no
# organisation holds, and attaches each one. The account must be the Accounting
# owner. The attach is idempotent — running it twice changes nothing.

param(
  [Parameter(Mandatory = $true)][string]$Email,
  [Parameter(Mandatory = $true)][string]$Password,
  [string]$Api = "https://api.grav.in"
)

# Windows PowerShell 5.1 still defaults to TLS 1.0 for some hosts, which these
# endpoints refuse. Set it explicitly or every call fails with a connection error.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$ErrorActionPreference = "Stop"

function Post($Url, $Body, $Token) {
  $headers = @{ "Content-Type" = "application/json" }
  if ($Token) { $headers["Authorization"] = "Bearer $Token" }
  return Invoke-RestMethod -Method Post -Uri $Url -Headers $headers -Body ($Body | ConvertTo-Json)
}
function Get($Url, $Token) {
  return Invoke-RestMethod -Method Get -Uri $Url -Headers @{ "Authorization" = "Bearer $Token" }
}

Write-Host "signing in..."
$login = Post "$Api/api/auth/login" @{ email = $Email; password = $Password } $null
if (-not $login.token) { Write-Host "Sign-in failed - check the email and password." ; exit 1 }
Write-Host "  signed in as $($login.user.role)"

$sync = Post "$Api/api/accountant/auth/sync-legacy" @{} $login.token
if (-not $sync.token) {
  Write-Host "  No accounting session: $($sync.message)"
  exit 1
}
Write-Host "  accounting session ok ($($sync.user.role))"

$un = Get "$Api/api/accountant/tally/companies/unattached" $sync.token
if (-not $un.companies -or $un.companies.Count -eq 0) {
  Write-Host "Nothing unattached - already consistent."
} else {
  foreach ($c in $un.companies) {
    Write-Host "  attaching $($c.companyName) ..."
    $r = Post "$Api/api/accountant/tally/companies/$($c._id)/attach" @{} $sync.token
    Write-Host "    -> $($r.message)"
  }
}

Write-Host ""
Write-Host "company list now:"
$list = Get "$Api/api/accountant/tally/companies" $sync.token
foreach ($c in $list.companies) { Write-Host "   $($c.companyName)" }
Write-Host "   count $(@($list.companies).Count)"
