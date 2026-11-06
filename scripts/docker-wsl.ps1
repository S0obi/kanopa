# Starts Docker Engine inside the default WSL distro and keeps the distro awake,
# so the Windows side can reach the Docker API on tcp://localhost:2375.
# Setup once (inside WSL): Docker Engine listening on -H tcp://127.0.0.1:2375 (see test/ldap/README.md).
$ErrorActionPreference = 'Stop'

# WSL stops an idle distro, and Docker with it. A sleeping process keeps it up.
$keepalive = Get-CimInstance Win32_Process -Filter "Name = 'wsl.exe'" |
    Where-Object { $_.CommandLine -like '*kanopa-keepalive*' }
if (-not $keepalive) {
    # dockerd is socket-activated, so the TCP listener only exists once it is started.
    Start-Process wsl.exe -ArgumentList '-u', 'root', '--', 'bash', '-c', '"systemctl start docker; exec -a kanopa-keepalive sleep infinity"' -WindowStyle Hidden
}

for ($i = 0; $i -lt 30; $i++) {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://localhost:2375/_ping
        if ($r.Content -eq 'OK') { Write-Output 'Docker is up on tcp://localhost:2375'; exit 0 }
    } catch { Start-Sleep -Milliseconds 500 }
}
Write-Error 'Docker did not answer on tcp://localhost:2375 within 15 seconds.'
