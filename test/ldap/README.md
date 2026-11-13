# Test directory

An OpenLDAP server seeded like the sample directory in Kanopa's design. The Go integration tests start it with testcontainers. You start it by hand for checkpoints.

```bash
wails3 task ldap:up        # localhost:389 (plain, StartTLS) and localhost:636 (LDAPS)
wails3 task ldap:search DN=uid=ada,ou=people,dc=example,dc=org
wails3 task ldap:stop      # see how Kanopa reacts to a server going away
wails3 task ldap:start
wails3 task ldap:down
```

## Accounts (test values only)

| Account | DN | Password |
|---|---|---|
| Admin (read-write, rootdn) | `cn=admin,dc=example,dc=org` | `kanopa-admin` |
| Reader (read-only) | `uid=svc-kanopa,ou=services,dc=example,dc=org` | `kanopa-reader` |
| Every person | `uid=<uid>,ou=people,dc=example,dc=org` | `kanopa-person` |
| Anonymous | (none) | (none), read access |

## Contents

- `dc=example,dc=org` with `ou=people` (1,182 entries: Ada Lovelace, Grace Hopper, Alan Turing … plus generated names), `ou=groups` (24 `groupOfNames` and 3 `posixGroup`), `ou=services` (3 accounts) and `ou=hosts` (70 devices)
- a `jpegPhoto` on Ada, `{SSHA}` passwords, `manager` DNs
- `ou=groups` also holds three `posixGroup` entries (`unix-staff`, `unix-devs`, `unix-empty`) that list members by uid; `unix-devs` lists a uid nobody carries (`ghost.user`) and one two entries carry (`twin`)
- `ou=edge`: awkward cases: escaped and multi-valued names, non-ASCII and very long values, an attribute with 80 values, a binary photo, and eight nested units
- `ou=partners`: a referral to `ldap://partners.example.org/…`
- Alpine 3.24, OpenLDAP 2.6.15
- TLS from a throwaway CA built into the image. It is never trusted, so keep **Verify the server certificate** off when connecting to it.
- plain searches stop at 500 entries; paged searches get everything

`seed.ldif` is generated: edit `seedgen/main.go`, then run `wails3 task ldap:seed`.

## Docker on Windows

Kanopa's tasks expect Docker Engine inside WSL (no Docker Desktop). Setup inside the WSL distro, once:

```bash
sudo apt install docker.io docker-compose-v2
sudo systemctl mask systemd-networkd-wait-online.service   # it hangs WSL boot, and Docker waits on it
sudo mkdir -p /etc/systemd/system/docker.service.d
printf '[Service]\nExecStart=\nExecStart=/usr/bin/dockerd -H fd:// -H tcp://127.0.0.1:2375 --containerd=/run/containerd/containerd.sock\n' \
  | sudo tee /etc/systemd/system/docker.service.d/override.conf
sudo systemctl daemon-reload && sudo systemctl enable --now docker
```

`wails3 task docker:up` (run by the other tasks) starts Docker and keeps WSL awake with a hidden `sleep` process, so Windows reaches the API on `tcp://localhost:2375`. That port is bound to localhost only, but anyone on this computer who reaches it has root in WSL.

If `docker pull` in WSL fails with `docker-credential-desktop.exe: executable file not found`, your WSL `~/.docker/config.json` still names Docker Desktop's credential helper. Remove its `"credsStore": "desktop.exe"` line. Until then, a public image can be pulled anonymously:

```bash
wsl -- bash -c 'mkdir -p /tmp/docker-anon && DOCKER_CONFIG=/tmp/docker-anon docker pull alpine:3.24'
```

On macOS, any Docker works and no setup is needed.

## Kanopa started from the Claude app

The Claude desktop app is an MSIX package, so Windows redirects `AppData\Roaming` for every program it starts. A Kanopa launched from a Claude session writes its connections and logs under `%LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Kanopa`, not `%AppData%\Kanopa`. Start Kanopa from Explorer or your own terminal when you check where it keeps its files.

## Large profile

For the performance checks: `ou=archive` with 10,000 people (`uid=arch00001` to `arch10000`) and `cn=everyone,ou=groups`, a group of 5,000 members. It is opt-in, because loading it takes a little longer.

```bash
task ldap:seed-large              # writes test/ldap/seed-large.ldif (not committed)
task ldap:up PROFILE=large        # the test directory with the large profile
KANOPA_LDAP_PROFILE=large go test -tags integration -run TestLarge -v ./services/...
```

The tests print how long each step took and fail past a limit set many times higher. The GitHub workflow "Large directory" runs the same by hand.
