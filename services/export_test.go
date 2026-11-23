package services

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-ldap/ldap/v3"

	"github.com/S0obi/kanopa/internal/fakeldap"
)

var exportTime = time.Date(2026, 11, 23, 10, 30, 5, 0, time.UTC)

// exportDirectory is a small tree with a password hash, a secret, a binary value and an operational attribute.
func exportDirectory() []fakeldap.Entry {
	person := []string{"inetOrgPerson", "organizationalPerson", "person", "top"}
	return []fakeldap.Entry{
		entry(fakeBase, map[string][]string{"objectClass": {"dcObject", "organization", "top"}, "dc": {"example"}}),
		entry(fakePeople, map[string][]string{"objectClass": {"organizationalUnit", "top"}, "ou": {"people"}}),
		entry("uid=ada,"+fakePeople, map[string][]string{"objectClass": person, "uid": {"ada"}, "cn": {"Ada Lovelace"}, "sn": {"Lovelace"},
			"userPassword": {"{SSHA}abcdef"}, "sambaNTPassword": {"0123456789ABCDEF"}, "unicodePwd": {"secret"}, "jpegPhoto": {"\xff\xd8\xff"},
			"mail": {"ada@example.org"}, "createTimestamp": {"20261106100000Z"}}),
	}
}

func startExport(t *testing.T, d *DirectoryService, id, dn, path string, opts ExportOptions) ExportStatus {
	t.Helper()
	st := d.StartExport(id, dn, path, opts)
	if st.Failure != nil {
		t.Fatalf("start: %+v", st.Failure)
	}
	return waitExport(t, d, st.Job)
}

func waitExport(t *testing.T, d *DirectoryService, job string) ExportStatus {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if st := d.ExportProgress(job); st.State != ExportRunning {
			return st
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("the export did not end")
	return ExportStatus{}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func leftovers(t *testing.T, dir string) []string {
	t.Helper()
	var out []string
	files, _ := os.ReadDir(dir)
	for _, f := range files {
		if strings.HasPrefix(f.Name(), ".kanopa-export-") {
			out = append(out, f.Name())
		}
	}
	return out
}

func TestExportWritesAnEntryWithoutHashesOrOperationalAttributes(t *testing.T) {
	srv := fakeldap.Start(t, exportDirectory(), fakeldap.Options{Paging: true, HasSubordinates: true})
	d, id, _ := connectFake(t, srv, WithVersion("0.2.0"), WithClock(func() time.Time { return exportTime }))
	dir := t.TempDir()
	path := filepath.Join(dir, "ada.ldif")

	st := startExport(t, d, id, "uid=ada,"+fakePeople, path, ExportOptions{})
	if st.State != ExportDone || st.Written != 1 || st.Incomplete || st.OutOfOrder {
		t.Fatalf("unexpected %+v", st)
	}
	want := `version: 1
# Exported by Kanopa 0.2.0 on 2026-11-23 10:30:05 UTC
# Base: uid=ada,ou=people,dc=example,dc=org
# Scope: this entry only
# Password hashes and secrets: not included

dn: uid=ada,ou=people,dc=example,dc=org
objectClass: inetOrgPerson
objectClass: organizationalPerson
objectClass: person
objectClass: top
cn: Ada Lovelace
jpegPhoto:: /9j/
mail: ada@example.org
sn: Lovelace
uid: ada

`
	if got := readFile(t, path); got != want {
		t.Fatalf("file:\n%s\nwant:\n%s", got, want)
	}
	if left := leftovers(t, dir); len(left) != 0 {
		t.Fatalf("temporary files left behind: %v", left)
	}
}

func TestExportIncludesSecretsOnlyWhenAsked(t *testing.T) {
	srv := fakeldap.Start(t, exportDirectory(), fakeldap.Options{Paging: true})
	d, id, _ := connectFake(t, srv)
	path := filepath.Join(t.TempDir(), "ada.ldif")

	startExport(t, d, id, "uid=ada,"+fakePeople, path, ExportOptions{Secrets: true})
	got := readFile(t, path)
	for _, name := range []string{"userPassword: ", "sambaNTPassword: ", "unicodePwd: "} {
		if !strings.Contains(got, name) {
			t.Errorf("%s is missing with secrets asked for", name)
		}
	}
	if !strings.Contains(got, "secrets: included") {
		t.Error("the header doesn't say secrets are included")
	}

	startExport(t, d, id, "uid=ada,"+fakePeople, path, ExportOptions{})
	got = readFile(t, path)
	for _, name := range []string{"userPassword", "sambaNTPassword", "unicodePwd", "SSHA", "createTimestamp"} {
		if strings.Contains(got, name) {
			t.Errorf("%s is in a file exported without secrets", name)
		}
	}
}

func TestExportOfASubtreeIsParentBeforeChild(t *testing.T) {
	srv := fakeldap.Start(t, exportDirectory(), fakeldap.Options{Paging: true})
	d, id, _ := connectFake(t, srv)
	path := filepath.Join(t.TempDir(), "people.ldif")

	st := startExport(t, d, id, fakePeople, path, ExportOptions{Subtree: true})
	if st.State != ExportDone || st.Written != 2 || st.OutOfOrder {
		t.Fatalf("unexpected %+v", st)
	}
	got := readFile(t, path)
	if !strings.Contains(got, "# Scope: this entry and everything below") ||
		strings.Index(got, "dn: ou=people") > strings.Index(got, "dn: uid=ada") {
		t.Fatalf("file:\n%s", got)
	}
}

func TestExportSaysWhenAChildComesBeforeItsParent(t *testing.T) {
	person := []string{"inetOrgPerson", "top"}
	entries := []fakeldap.Entry{
		entry(fakeBase, map[string][]string{"objectClass": {"dcObject", "organization", "top"}, "dc": {"example"}}),
		entry("uid=ada,"+fakePeople, map[string][]string{"objectClass": person, "uid": {"ada"}, "cn": {"Ada"}, "sn": {"Lovelace"}}),
		entry(fakePeople, map[string][]string{"objectClass": {"organizationalUnit", "top"}, "ou": {"people"}}),
	}
	srv := fakeldap.Start(t, entries, fakeldap.Options{Paging: true})
	d, id, _ := connectFake(t, srv)
	st := startExport(t, d, id, fakeBase, filepath.Join(t.TempDir(), "all.ldif"), ExportOptions{Subtree: true})
	if st.State != ExportDone || !st.OutOfOrder || st.Written != 3 {
		t.Fatalf("unexpected %+v", st)
	}
}

func TestExportKeepsAFileTheServerCutShortAndSaysSo(t *testing.T) {
	srv := fakeldap.Start(t, fakeDirectory(1200), fakeldap.Options{SizeLimit: 500})
	d, id, _ := connectFake(t, srv)
	path := filepath.Join(t.TempDir(), "people.ldif")

	st := startExport(t, d, id, fakePeople, path, ExportOptions{Subtree: true})
	if st.State != ExportDone || !st.Incomplete || st.Written != 500 ||
		st.Reason != "the server stopped after 500 entries. Size limit exceeded (4)" {
		t.Fatalf("unexpected %+v", st)
	}
	got := readFile(t, path)
	if !strings.HasSuffix(got, "# Incomplete: the server stopped after 500 entries. Size limit exceeded (4)\n") {
		t.Fatalf("the file doesn't end with the incomplete comment:\n...%s", got[max(0, len(got)-200):])
	}
}

func TestExportOfAMissingEntryLeavesNoFile(t *testing.T) {
	srv := fakeldap.Start(t, exportDirectory(), fakeldap.Options{Paging: true})
	d, id, _ := connectFake(t, srv)
	dir := t.TempDir()
	path := filepath.Join(dir, "gone.ldif")

	st := startExport(t, d, id, "uid=nobody,"+fakePeople, path, ExportOptions{})
	if st.State != ExportFailed || st.Failure == nil || st.Failure.Code != 32 {
		t.Fatalf("unexpected %+v", st)
	}
	if _, err := os.Stat(path); err == nil {
		t.Fatal("a file was written for an export that failed")
	}
	if left := leftovers(t, dir); len(left) != 0 {
		t.Fatalf("temporary files left behind: %v", left)
	}
}

func TestCancelingAnExportNeverTouchesTheFileItWouldReplace(t *testing.T) {
	srv := fakeldap.Start(t, fakeDirectory(1200), fakeldap.Options{Paging: true, Delay: 150 * time.Millisecond})
	d, id, _ := connectFake(t, srv)
	dir := t.TempDir()
	path := filepath.Join(dir, "people.ldif")
	if err := os.WriteFile(path, []byte("precious"), 0o600); err != nil {
		t.Fatal(err)
	}

	st := d.StartExport(id, fakePeople, path, ExportOptions{Subtree: true})
	if st.Failure != nil || st.State != ExportRunning {
		t.Fatalf("start: %+v", st)
	}
	time.Sleep(250 * time.Millisecond)
	d.CancelExport(st.Job)
	if end := waitExport(t, d, st.Job); end.State != ExportCanceled {
		t.Fatalf("unexpected %+v", end)
	}
	if got := readFile(t, path); got != "precious" {
		t.Fatalf("the existing file was changed: %q", got)
	}
	if left := leftovers(t, dir); len(left) != 0 {
		t.Fatalf("temporary files left behind: %v", left)
	}
}

func TestAnExportReplacesAnExistingFileOnlyWhenDone(t *testing.T) {
	srv := fakeldap.Start(t, exportDirectory(), fakeldap.Options{Paging: true})
	d, id, _ := connectFake(t, srv)
	path := filepath.Join(t.TempDir(), "ada.ldif")
	if err := os.WriteFile(path, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	startExport(t, d, id, "uid=ada,"+fakePeople, path, ExportOptions{})
	if got := readFile(t, path); !strings.HasPrefix(got, "version: 1\n") {
		t.Fatalf("the file wasn't replaced: %q", got)
	}
}

func TestExportRefusesWhatItCannotWrite(t *testing.T) {
	srv := fakeldap.Start(t, exportDirectory(), fakeldap.Options{Paging: true})
	d, id, _ := connectFake(t, srv)
	dir := t.TempDir()
	for name, path := range map[string]string{
		"no path":        "",
		"relative":       "ada.ldif",
		"a folder":       dir,
		"missing folder": filepath.Join(dir, "nope", "ada.ldif"),
	} {
		if st := d.StartExport(id, fakePeople, path, ExportOptions{}); st.Failure == nil || st.State != ExportFailed {
			t.Errorf("%s: unexpected %+v", name, st)
		}
	}
	if st := d.StartExport("closed", fakePeople, filepath.Join(dir, "a.ldif"), ExportOptions{}); st.Failure == nil || !st.Failure.Lost {
		t.Errorf("a closed connection: unexpected %+v", st)
	}
	if st := d.ExportProgress("export-999"); st.State != ExportFailed || st.Failure == nil {
		t.Errorf("an unknown job: unexpected %+v", st)
	}
}

func TestExportAttrsLeavesOutWhatTheSchemaCallsOperational(t *testing.T) {
	// Without a schema, the well-known operational names are still left out.
	e := &ldap.Entry{DN: "cn=x", Attributes: []*ldap.EntryAttribute{{Name: "cn", ByteValues: [][]byte{[]byte("x")}}, {Name: "entryUUID", ByteValues: [][]byte{[]byte("1")}}, {Name: "modifyTimestamp", ByteValues: [][]byte{[]byte("2")}}}}
	attrs := exportAttrs(e, nil, true)
	if len(attrs) != 1 || attrs[0].Name != "cn" {
		t.Fatalf("got %+v", attrs)
	}
}
