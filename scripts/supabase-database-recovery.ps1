[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Preflight", "Backup", "Restore")]
  [string]$Mode,

  [Parameter(Mandatory = $true)]
  [string]$OutputDirectory,

  [string]$ConfirmSourceRef,
  [string]$ConfirmTargetRef
)

$ErrorActionPreference = "Stop"
$SupabaseCliVersion = "2.117.0"
$StagingProjectRef = "yyleaedclbhsiowsaunt"
$ProductionProjectRef = "czcurayfzshrqievceww"
$resolvedOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
$manifestPath = Join-Path $resolvedOutput "database-backup-manifest.json"

function Get-CommandState([string]$Name) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  return [ordered]@{
    available = [bool]$command
    source = if ($command) { $command.Source } else { $null }
  }
}

function Get-DatabaseUrl([string]$Name) {
  $value = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "$Name is required and must contain the percent-encoded Supabase Session Pooler URL."
  }
  $uri = [Uri]$value
  if ($uri.Scheme -notin @("postgres", "postgresql")) {
    throw "$Name must use the postgres or postgresql scheme."
  }
  return $value
}

function Get-ProjectRef([string]$DatabaseUrl) {
  $uri = [Uri]$DatabaseUrl
  $user = $uri.UserInfo.Split(":", 2)[0]
  if ($user -match '^postgres\.([a-z0-9]+)$') {
    return $Matches[1]
  }
  if ($uri.Host -match '^db\.([a-z0-9]+)\.supabase\.co$') {
    return $Matches[1]
  }
  throw "Unable to derive a Supabase project ref from the database URL."
}

function Assert-ProjectRef([string]$Actual, [string]$Expected, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Expected) -or $Actual -ne $Expected) {
    throw "$Label project ref confirmation must exactly equal $Actual."
  }
}

function Invoke-SupabaseDump([string[]]$Arguments) {
  & npx --yes "supabase@$SupabaseCliVersion" db dump @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Supabase CLI db dump failed with exit code $LASTEXITCODE."
  }
}

function Assert-BackupHashes {
  if (-not (Test-Path -LiteralPath $manifestPath)) {
    throw "Backup manifest does not exist: $manifestPath"
  }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  foreach ($entry in $manifest.files) {
    $path = Join-Path $resolvedOutput $entry.name
    if (-not (Test-Path -LiteralPath $path)) {
      throw "Backup file is missing: $($entry.name)"
    }
    $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne $entry.sha256) {
      throw "Backup checksum mismatch: $($entry.name)"
    }
  }
  return $manifest
}

if ($Mode -eq "Preflight") {
  $docker = Get-CommandState "docker"
  $podman = Get-CommandState "podman"
  $psql = Get-CommandState "psql"
  $npx = Get-CommandState "npx"
  [ordered]@{
    checkedAt = (Get-Date).ToUniversalTime().ToString("o")
    supabaseCliVersion = $SupabaseCliVersion
    npx = $npx
    docker = $docker
    podman = $podman
    psql = $psql
    sourceDatabaseUrlConfigured = -not [string]::IsNullOrWhiteSpace($env:CONUO_DR_SOURCE_DB_URL)
    targetDatabaseUrlConfigured = -not [string]::IsNullOrWhiteSpace($env:CONUO_DR_TARGET_DB_URL)
    backupReady = $npx.available -and ($docker.available -or $podman.available) -and -not [string]::IsNullOrWhiteSpace($env:CONUO_DR_SOURCE_DB_URL)
    restoreReady = $psql.available -and -not [string]::IsNullOrWhiteSpace($env:CONUO_DR_TARGET_DB_URL)
  } | ConvertTo-Json -Depth 4
  exit 0
}

if ($Mode -eq "Backup") {
  $sourceDbUrl = Get-DatabaseUrl "CONUO_DR_SOURCE_DB_URL"
  $sourceRef = Get-ProjectRef $sourceDbUrl
  Assert-ProjectRef $sourceRef $ConfirmSourceRef "Source"
  if ($sourceRef -ne $StagingProjectRef) {
    throw "Database backup is restricted to the isolated Conuo staging project."
  }
  if (-not (Get-Command npx -ErrorAction SilentlyContinue)) {
    throw "npx is required."
  }
  if (-not (Get-Command docker -ErrorAction SilentlyContinue) -and -not (Get-Command podman -ErrorAction SilentlyContinue)) {
    throw "Supabase CLI db dump requires Docker or Podman."
  }
  if (Test-Path -LiteralPath $resolvedOutput) {
    $existing = @(Get-ChildItem -LiteralPath $resolvedOutput -Force)
    if ($existing.Count -gt 0) {
      throw "Backup output directory must be empty: $resolvedOutput"
    }
  } else {
    New-Item -ItemType Directory -Path $resolvedOutput | Out-Null
  }

  $marker = Join-Path $resolvedOutput ".incomplete"
  Set-Content -LiteralPath $marker -Value "database backup in progress" -Encoding utf8NoBOM
  Invoke-SupabaseDump @("--db-url", $sourceDbUrl, "--file", (Join-Path $resolvedOutput "roles.sql"), "--role-only")
  Invoke-SupabaseDump @("--db-url", $sourceDbUrl, "--file", (Join-Path $resolvedOutput "schema.sql"))
  Invoke-SupabaseDump @(
    "--db-url", $sourceDbUrl,
    "--file", (Join-Path $resolvedOutput "data.sql"),
    "--data-only", "--use-copy",
    "--exclude", "storage.buckets_vectors",
    "--exclude", "storage.vector_indexes"
  )
  Invoke-SupabaseDump @(
    "--db-url", $sourceDbUrl,
    "--file", (Join-Path $resolvedOutput "history-schema.sql"),
    "--schema", "supabase_migrations"
  )
  Invoke-SupabaseDump @(
    "--db-url", $sourceDbUrl,
    "--file", (Join-Path $resolvedOutput "history-data.sql"),
    "--schema", "supabase_migrations", "--data-only", "--use-copy"
  )

  $files = @("roles.sql", "schema.sql", "data.sql", "history-schema.sql", "history-data.sql") | ForEach-Object {
    $path = Join-Path $resolvedOutput $_
    [ordered]@{
      name = $_
      bytes = (Get-Item -LiteralPath $path).Length
      sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  }
  [ordered]@{
    schemaVersion = 1
    createdAt = (Get-Date).ToUniversalTime().ToString("o")
    sourceProjectRef = $sourceRef
    supabaseCliVersion = $SupabaseCliVersion
    files = $files
  } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding utf8NoBOM
  Remove-Item -LiteralPath $marker
  Write-Output ($files | Select-Object name, bytes, sha256 | ConvertTo-Json -Depth 3)
  exit 0
}

$targetDbUrl = Get-DatabaseUrl "CONUO_DR_TARGET_DB_URL"
$targetRef = Get-ProjectRef $targetDbUrl
Assert-ProjectRef $targetRef $ConfirmTargetRef "Target"
$protectedRefs = @($StagingProjectRef, $ProductionProjectRef)
if ($targetRef -in $protectedRefs) {
  throw "Restore target must be a separate disposable project, not staging or production."
}
$manifest = Assert-BackupHashes
if ($manifest.sourceProjectRef -eq $targetRef) {
  throw "Restore target must differ from the backup source project."
}
$psql = Get-Command psql -ErrorAction SilentlyContinue
if (-not $psql) {
  throw "psql is required for restore."
}

$mainArgs = @(
  "--single-transaction",
  "--variable", "ON_ERROR_STOP=1",
  "--file", (Join-Path $resolvedOutput "roles.sql"),
  "--file", (Join-Path $resolvedOutput "schema.sql"),
  "--command", "SET session_replication_role = replica",
  "--file", (Join-Path $resolvedOutput "data.sql"),
  "--dbname", $targetDbUrl
)
& $psql.Source @mainArgs
if ($LASTEXITCODE -ne 0) {
  throw "Primary database restore failed with exit code $LASTEXITCODE."
}

$historyArgs = @(
  "--single-transaction",
  "--variable", "ON_ERROR_STOP=1",
  "--file", (Join-Path $resolvedOutput "history-schema.sql"),
  "--file", (Join-Path $resolvedOutput "history-data.sql"),
  "--dbname", $targetDbUrl
)
& $psql.Source @historyArgs
if ($LASTEXITCODE -ne 0) {
  throw "Migration-history restore failed with exit code $LASTEXITCODE."
}

[ordered]@{
  restoredAt = (Get-Date).ToUniversalTime().ToString("o")
  targetProjectRef = $targetRef
  checksumsVerified = $true
  primaryRestore = "completed"
  migrationHistoryRestore = "completed"
} | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $resolvedOutput "database-restore-results.json") -Encoding utf8NoBOM
Write-Output '{"restored":true,"checksumsVerified":true}'
