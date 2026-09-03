# UptimeHost bootstrap — Windows PowerShell one-liner installer.
#
# Usage (replace USER/REPO with your GitHub repo):
#   iex ((New-Object Net.WebClient).DownloadString('https://raw.githubusercontent.com/USER/REPO/main/bootstrap.ps1'))
#
# Installs git + Node.js + npm (+ Go), clones the UptimeHost source and opens
# the setup.py DevOps menu (via py). Run from an elevated PowerShell if you
# want service setup to work without prompts.

$ErrorActionPreference = "Stop"

$repoUrl = if ($env:UH_REPO_URL) { $env:UH_REPO_URL } else { "https://github.com/USER/REPO.git" }
$branch  = if ($env:UH_BRANCH)  { $env:UH_BRANCH }  else { "main" }
$dir     = if ($env:UH_INSTALL_DIR) { $env:UH_INSTALL_DIR } else { Join-Path $HOME "uptimehost" }

function Say($m) { Write-Host "[UH] $m" -ForegroundColor Cyan }
function Fail($m) { Write-Error "[UH] error: $m"; exit 1 }
function Has($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

# ---- git (via winget) -----------------------------------------------------
if (-not (Has "git")) {
  Say "Installing git..."
  winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements
  # refresh PATH
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
}
git --version

# ---- Node.js (via winget) -------------------------------------------------
if (-not (Has "node")) {
  Say "Installing Node.js LTS..."
  winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
}
node -v; npm -v

# ---- Python (needed to run setup.py) --------------------------------------
if (-not (Has "py") -and -not (Has "python")) {
  Say "Installing Python..."
  winget install --id Python.Python.3.12 -e --source winget --accept-package-agreements --accept-source-agreements
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
}

# ---- Go (optional, for building the node agent) ----------------------------
if (-not (Has "go")) {
  Say "Installing Go (for node agent)..."
  winget install --id GoLang.Go -e --source winget --accept-package-agreements --accept-source-agreements
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
}

# ---- clone -----------------------------------------------------------------
if (-not (Test-Path (Join-Path $dir ".git"))) {
  Say "Cloning $repoUrl -> $dir"
  git clone --depth 1 --branch $branch $repoUrl $dir
} else {
  Say "Updating existing clone at $dir"
  Push-Location $dir; git pull --ff-only; Pop-Location
}

Set-Location $dir
if (-not (Test-Path "setup.py")) { Fail "setup.py not found in repo; commit it to GitHub first." }
$py = if (Has "py") { "py" } elseif (Has "python") { "python" } else { Fail "No Python found." }
Say "Running setup.py — pick an option (1 install panel, 2 install node, ...)"
& $py setup.py
