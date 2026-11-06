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

- `dc=example,dc=org` with `ou=people` (1,182 entries: Ada Lovelace, Grace Hopper, Alan Turing … plus generated names), `ou=groups` (24 `groupOfNames`), `ou=services` (3 accounts) and `ou=hosts` (70 devices)
- a `jpegPhoto` on Ada, `{SSHA}` passwords, `manager` DNs
- `ou=partners`: a referral to `ldap://partners.example.org/…`
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

On macOS, any Docker works and no setup is needed.
