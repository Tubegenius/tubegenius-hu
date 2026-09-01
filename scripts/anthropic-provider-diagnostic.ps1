# PFM Anthropic Provider Failure Taxonomy v0 -- secure PowerShell wrapper
# for scripts/anthropic-provider-diagnostic.ts.
#
# Makes EXACTLY ONE minimal, harmless Anthropic API call (see the .ts file's
# own header) after an explicit --confirm-diagnostic + typed YES
# confirmation. The API key:
#   - is entered via Read-Host -AsSecureString (never echoed to screen);
#   - is NEVER passed as a command-line argument to the child process;
#   - is NEVER written to a file or to shell history;
#   - is set as a process environment variable ONLY for the lifetime of
#     the one child `node` invocation below, and is removed again in a
#     `finally` block that runs even on Ctrl+C or an unhandled error.
#
# This script itself does NOT run the diagnostic call automatically when
# sourced/loaded -- it only runs when explicitly invoked by the operator.
#
# -ProductionParity: opt-in switch. Matches max_tokens and the presence of
# a system parameter to the real production request shape (see the .ts
# file's own --production-parity flag and PARITY_SYSTEM_PROMPT comment).
# Requires its OWN separate authorization -- do not pass this switch
# without that.
param(
    [switch]$ProductionParity
)
$ErrorActionPreference = 'Stop'

function ConvertFrom-SecureStringPlain($secureString) {
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureString)
    try { [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

Write-Host "=== Anthropic Provider Diagnostic v0 ===" -ForegroundColor Cyan
if ($ProductionParity) {
    Write-Host "Ez PONTOSAN EGY, artalmatlan Anthropic API-hivast fog inditani PRODUCTION-PARITY modban" -ForegroundColor Cyan
    Write-Host "(max_tokens es system parameter is a valodi production request alakjat koveti)," -ForegroundColor Cyan
} else {
    Write-Host "Ez PONTOSAN EGY, artalmatlan Anthropic API-hivast fog inditani (max_tokens=1)," -ForegroundColor Cyan
}
Write-Host "a production extractionben hasznalt pontos modell-azonositoval." -ForegroundColor Cyan
Write-Host ""
Write-Host "Type YES (exact case) to proceed:" -ForegroundColor Red
$confirm = Read-Host
if ($confirm -cne 'YES') {
    Write-Host "Aborted -- confirmation not given." -ForegroundColor Yellow
    exit 1
}

Write-Host "`n=== Anthropic API key (csak ennek az egy hivasnak a idejere elerheto) ===" -ForegroundColor Yellow
$pw = Read-Host -AsSecureString 'ANTHROPIC_API_KEY'
$plainKey = ConvertFrom-SecureStringPlain $pw
$pw = $null

$repoRoot = 'C:\Projektek\WillViralFinal'
$exitCode = 4

try {
    $env:ANTHROPIC_API_KEY = $plainKey
    $plainKey = $null

    Push-Location $repoRoot
    try {
        if ($ProductionParity) {
            & node "scripts/anthropic-provider-diagnostic.ts" --confirm-diagnostic --production-parity
        } else {
            & node "scripts/anthropic-provider-diagnostic.ts" --confirm-diagnostic
        }
        $exitCode = $LASTEXITCODE
    } finally {
        Pop-Location
    }
}
finally {
    # Runs even on Ctrl+C or an unhandled error above -- the key is never
    # left set in this shell's environment beyond the one child-process call.
    Remove-Item Env:\ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
}

Write-Host "`nExit code: $exitCode" -ForegroundColor Cyan
Write-Host "Masold be nekem a teljes (mar redaktalt) kimenetet." -ForegroundColor Cyan
exit $exitCode
