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
#
# PFM Anthropic Explicit Workspace-Scoped Authentication Mode gate: the
# wrapper now ALSO asks the operator to pick an auth scope mode via a
# closed, validated choice (never free text) before prompting for any
# credential:
#   [1] workspace_scoped -- the key is scoped to exactly one workspace.
#       No workspace ID prompt at all; ANTHROPIC_WORKSPACE_ID is
#       unconditionally cleared before the child process starts, even if
#       something happened to be set in the parent shell already, so a
#       stale value can never leak into the header decision.
#   [2] identity_linked -- the key is NOT scoped to one workspace (e.g.
#       "All workspaces"). A SEPARATE secure prompt asks for the
#       workspace ID, same protections as the API key.
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

Write-Host "`n=== Auth scope mode (zart valasztas -- nem szabad kulcs kitalalni) ===" -ForegroundColor Cyan
Write-Host "[1] workspace_scoped -- a kulcs EGYETLEN workspace-re van skalazva. Nincs szukseg workspace ID-ra."
Write-Host "[2] identity_linked  -- a kulcs TOBB workspace-hez fer hozza (pl. 'All workspaces'). Workspace ID is kell."
$authScopeMode = $null
while ($true) {
    $choice = Read-Host "Valassz (1 vagy 2)"
    if ($choice -eq '1') { $authScopeMode = 'workspace_scoped'; break }
    elseif ($choice -eq '2') { $authScopeMode = 'identity_linked'; break }
    else { Write-Host "Ervenytelen valasztas -- csak 1 vagy 2 lehet." -ForegroundColor Yellow }
}
Write-Host "Kivalasztott mod: $authScopeMode" -ForegroundColor Cyan

Write-Host "`n=== Anthropic API key (csak ennek az egy hivasnak a idejere elerheto) ===" -ForegroundColor Yellow
$pw = Read-Host -AsSecureString 'ANTHROPIC_API_KEY'
$plainKey = ConvertFrom-SecureStringPlain $pw
$pw = $null

$plainWorkspaceId = $null
if ($authScopeMode -eq 'identity_linked') {
    # A SEPARATE secure prompt, never reused from the API key one above --
    # not a true secret (see anthropic-workspace-config.ts's own header),
    # but still entered via Read-Host -AsSecureString and cleared in
    # `finally` alongside the API key, same protections, never printed,
    # never a command-line argument.
    Write-Host "`n=== Anthropic workspace ID (anthropic-workspace-id fejlechez, csak ennek az egy hivasnak a idejere elerheto) ===" -ForegroundColor Yellow
    $wsPw = Read-Host -AsSecureString 'ANTHROPIC_WORKSPACE_ID'
    $plainWorkspaceId = ConvertFrom-SecureStringPlain $wsPw
    $wsPw = $null
}

$repoRoot = 'C:\Projektek\WillViralFinal'
$exitCode = 4

try {
    $env:ANTHROPIC_API_KEY = $plainKey
    $plainKey = $null
    $env:ANTHROPIC_AUTH_SCOPE_MODE = $authScopeMode

    if ($authScopeMode -eq 'identity_linked') {
        $env:ANTHROPIC_WORKSPACE_ID = $plainWorkspaceId
        $plainWorkspaceId = $null
    } else {
        # workspace_scoped: unconditionally clear ANTHROPIC_WORKSPACE_ID
        # before the child process starts, even if the parent shell
        # happened to have one set from an earlier identity_linked run in
        # the same terminal session -- a stale value must never leak into
        # this run's header decision (the CLI itself also never reads it
        # in this mode, but the wrapper does not rely on that alone).
        Remove-Item Env:\ANTHROPIC_WORKSPACE_ID -ErrorAction SilentlyContinue
    }

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
    # Runs even on Ctrl+C or an unhandled error above -- none of these
    # values are ever left set in this shell's environment beyond the one
    # child-process call. ANTHROPIC_AUTH_SCOPE_MODE is not sensitive, but
    # is cleared too for hygiene/consistency.
    Remove-Item Env:\ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:\ANTHROPIC_WORKSPACE_ID -ErrorAction SilentlyContinue
    Remove-Item Env:\ANTHROPIC_AUTH_SCOPE_MODE -ErrorAction SilentlyContinue
}

Write-Host "`nExit code: $exitCode" -ForegroundColor Cyan
Write-Host "Masold be nekem a teljes (mar redaktalt) kimenetet." -ForegroundColor Cyan
Write-Host "Zard be ezt a PowerShell-ablakot most -- ne hasznald ujra mas celra." -ForegroundColor Yellow
exit $exitCode
