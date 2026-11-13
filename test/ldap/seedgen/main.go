// Command seedgen writes test/ldap/seed.ldif: the sample directory drawn in
// Kanopa's design (Ada, Grace, ou=people with 1,182 entries, 24 groups,
// 3 service accounts, 70 hosts and one referral). Output is deterministic.
//
//	go run ./test/ldap/seedgen > test/ldap/seed.ldif
//
// With -large it writes the large profile instead, to be loaded after the sample directory:
// ou=archive with 10,000 people and cn=everyone, a group of 5,000 members.
//
//	go run ./test/ldap/seedgen -large > test/ldap/seed-large.ldif
package main

import (
	"bufio"
	"bytes"
	"crypto/sha1" //nolint:gosec // {SSHA} is what OpenLDAP stores by default
	"encoding/base64"
	"flag"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"math/rand/v2"
	"os"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

const (
	base           = "dc=example,dc=org"
	personPassword = "kanopa-person"
	readerPassword = "kanopa-reader"
	servicePasswd  = "kanopa-service"
	peopleTotal    = 1182
	groupsTotal    = 24
	hostsTotal     = 70
)

type person struct {
	uid, given, sn, title, dept, phone, emp, manager string
}

var named = []person{
	{"ada", "Ada", "Lovelace", "Principal engineer", "Research", "+41 44 555 01 10", "1001", "grace"},
	{"alan", "Alan", "Turing", "Research scientist", "Research", "+41 44 555 01 14", "1002", "ada"},
	{"grace", "Grace", "Hopper", "Director of engineering", "Engineering", "+41 44 555 01 02", "1003", ""},
	{"katherine", "Katherine", "Johnson", "Data scientist", "Research", "+41 44 555 01 21", "1004", "ada"},
	{"margaret", "Margaret", "Hamilton", "Software engineer", "Engineering", "+41 44 555 01 33", "1005", "grace"},
	{"edsger", "Edsger", "Dijkstra", "Software engineer", "Engineering", "+41 44 555 01 37", "1006", "grace"},
}

var firsts = []string{"Adele", "Bruno", "Chiara", "Dario", "Elena", "Fabio", "Greta", "Hugo", "Ines", "Jonas",
	"Lea", "Marco", "Nora", "Oscar", "Paula", "Quentin", "Rosa", "Simon", "Tara", "Urs",
	"Vera", "Walter", "Xenia", "Yann", "Zoe", "Anton", "Bea", "Carl", "Dora", "Emil",
	"Flora", "Gino", "Hanna", "Ivo", "Jana", "Kurt", "Lina", "Max", "Nina", "Otto"}

var lasts = []string{"Ammann", "Bianchi", "Cattaneo", "Dubois", "Egger", "Favre", "Gerber", "Huber", "Imhof", "Jaquet",
	"Keller", "Lüthi", "Meier", "Nussbaum", "Ott", "Perrin", "Rossi", "Schmid", "Tanner", "Vogel",
	"Weber", "Zürcher", "Baumann", "Frei", "Graf", "Hofer", "Kunz", "Moser", "Roth", "Steiner"}

var titles = []string{"Software engineer", "Support specialist", "Account manager", "Analyst", "Designer", "Technician", "Consultant"}
var depts = []string{"Engineering", "Research", "Support", "Sales", "Operations", "Finance"}

var groups = []struct{ cn, desc string }{
	{"admins", "Directory administrators"},
	{"engineering", "Engineering department"},
	{"research", "Research department"},
	{"support", "Support team"},
	{"vpn-users", "Remote access through the VPN"},
	{"design", "Product design"}, {"finance", "Finance department"}, {"hr", "Human resources"},
	{"legal", "Legal department"}, {"marketing", "Marketing team"}, {"operations", "Operations team"},
	{"platform", "Platform team"}, {"qa", "Quality assurance"}, {"sales", "Sales team"},
	{"security", "Security team"}, {"data", "Data team"}, {"devops", "DevOps team"},
	{"mobile", "Mobile apps team"}, {"web", "Web team"}, {"infra", "Infrastructure team"},
	{"analytics", "Analytics team"}, {"it-helpdesk", "IT help desk"}, {"wiki-editors", "Wiki editors"},
	{"interns", "Interns"},
}

var namedMembers = map[string][]string{
	"admins":      {"ada", "grace"},
	"engineering": {"grace", "margaret", "ada"},
	"research":    {"ada", "alan", "katherine"},
	"support":     {"katherine"},
	"vpn-users":   {"grace", "alan", "margaret"},
}

var rng = rand.New(rand.NewPCG(2026, 11))

// The large profile.
const (
	largeChildren = 10_000
	largeMembers  = 5_000
)

// writeLarge writes ou=archive and cn=everyone.
func writeLarge(w *bufio.Writer) {
	archive := "ou=archive," + base
	entry(w, archive, "objectClass: organizationalUnit", "objectClass: top", "ou: archive", "description: Former employees and old accounts")
	members := make([]string, 0, largeMembers)
	for i := 1; i <= largeChildren; i++ {
		uid := fmt.Sprintf("arch%05d", i)
		dn := "uid=" + uid + "," + archive
		if i <= largeMembers {
			members = append(members, "member: "+dn)
		}
		entry(w, dn, "objectClass: inetOrgPerson", "objectClass: organizationalPerson", "objectClass: person", "objectClass: top",
			"uid: "+uid, fmt.Sprintf("cn: Archive %d", i), fmt.Sprintf("sn: Archive%d", i), "givenName: Archive", "mail: "+uid+"@example.org")
	}
	lines := append([]string{"objectClass: groupOfNames", "objectClass: top", "cn: everyone", "description: Everyone in the archive"}, members...)
	entry(w, "cn=everyone,ou=groups,"+base, lines...)
}

func main() {
	large := flag.Bool("large", false, "write the large profile (ou=archive, cn=everyone) instead of the sample directory")
	flag.Parse()
	w := bufio.NewWriter(os.Stdout)
	defer w.Flush()
	if *large {
		writeLarge(w)
		return
	}

	entry(w, base, "objectClass: dcObject", "objectClass: organization", "objectClass: top", "dc: example", "o: Example Organization")
	ou(w, "people", "People and their login accounts")
	ou(w, "groups", "Authorization groups")
	ou(w, "services", "Accounts used by applications")
	ou(w, "hosts", "Servers and network devices")

	uids := writePeople(w)
	writeGroups(w, uids)
	writeServices(w)
	writeHosts(w)
	writeEdge(w)

	entry(w, "ou=partners,"+base, "objectClass: referral", "objectClass: extensibleObject", "ou: partners",
		"ref: ldap://partners.example.org/ou=partners,dc=example,dc=org")
}

func entry(w *bufio.Writer, dn string, lines ...string) {
	fmt.Fprintf(w, "\ndn: %s\n", dn)
	for _, l := range lines {
		fmt.Fprintln(w, safe(l))
	}
}

// safe base64-encodes a value that is not plain ASCII, as LDIF requires.
func safe(line string) string {
	k, v, ok := strings.Cut(line, ": ")
	if !ok || strings.HasPrefix(v, ":") {
		return line
	}
	for _, r := range v {
		if r > unicode.MaxASCII {
			return k + ":: " + base64.StdEncoding.EncodeToString([]byte(v))
		}
	}
	return line
}

func ou(w *bufio.Writer, name, desc string) {
	entry(w, "ou="+name+","+base, "objectClass: organizationalUnit", "objectClass: top", "ou: "+name, "description: "+desc)
}

func ssha(pw string) string {
	salt := make([]byte, 4)
	for i := range salt {
		salt[i] = byte(rng.IntN(256))
	}
	h := sha1.New() //nolint:gosec
	h.Write([]byte(pw))
	h.Write(salt)
	return "{SSHA}" + base64.StdEncoding.EncodeToString(append(h.Sum(nil), salt...))
}

func slug(s string) string {
	var b strings.Builder
	for _, r := range norm.NFD.String(strings.ToLower(s)) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '.' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func personDN(uid string) string { return "uid=" + uid + ",ou=people," + base }

func writePeople(w *bufio.Writer) []string {
	people := append([]person{}, named...)
	n := 0
	for _, l := range lasts {
		for _, f := range firsts {
			if len(people) >= peopleTotal {
				break
			}
			n++
			people = append(people, person{
				uid: slug(f + "." + l), given: f, sn: l,
				title: titles[n%len(titles)], dept: depts[n%len(depts)],
				phone: fmt.Sprintf("+41 44 555 %02d %02d", 10+n/100%90, n%100), emp: fmt.Sprint(2000 + n),
				manager: named[n%len(named)].uid,
			})
		}
	}
	uids := make([]string, 0, len(people))
	for _, p := range people {
		uids = append(uids, p.uid)
		lines := []string{
			"objectClass: inetOrgPerson", "objectClass: organizationalPerson", "objectClass: person", "objectClass: top",
			"uid: " + p.uid, "cn: " + p.given + " " + p.sn, "sn: " + p.sn, "givenName: " + p.given,
			"mail: " + slug(p.given+"."+p.sn) + "@example.org",
			"title: " + p.title, "departmentNumber: " + p.dept, "employeeNumber: " + p.emp, "telephoneNumber: " + p.phone,
		}
		if p.manager != "" {
			lines = append(lines, "manager: "+personDN(p.manager))
		}
		lines = append(lines, "userPassword: "+ssha(personPassword))
		if p.uid == "ada" {
			lines = append(lines, "jpegPhoto:: "+base64.StdEncoding.EncodeToString(photo()))
		}
		entry(w, personDN(p.uid), lines...)
	}
	return uids
}

// photo is a small generated JPEG so binary values have something real to show.
func photo() []byte {
	img := image.NewRGBA(image.Rect(0, 0, 96, 96))
	for y := 0; y < 96; y++ {
		for x := 0; x < 96; x++ {
			img.Set(x, y, color.RGBA{uint8(160 + x/3), uint8(190 + y/4), uint8(150 + (x+y)/6), 255})
		}
	}
	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, img, &jpeg.Options{Quality: 90})
	return buf.Bytes()
}

func writeGroups(w *bufio.Writer, uids []string) {
	generated := uids[len(named):]
	for i, g := range groups[:groupsTotal] {
		members := namedMembers[g.cn]
		if members == nil {
			for j := 0; j < 3+i%6; j++ {
				members = append(members, generated[(i*37+j*11)%len(generated)])
			}
		}
		lines := []string{"objectClass: groupOfNames", "objectClass: top", "cn: " + g.cn, "description: " + g.desc}
		for _, m := range members {
			lines = append(lines, "member: "+personDN(m))
		}
		entry(w, "cn="+g.cn+",ou=groups,"+base, lines...)
	}
	writePosixGroups(w)
}

// writePosixGroups writes groups that list their members by uid (memberUid), as a Unix directory does.
// unix-devs lists a uid nobody carries (ghost.user), one two entries carry (twin, in ou=edge), and casey,
// a posixAccount in ou=edge that is named by cn, not by uid.
func writePosixGroups(w *bufio.Writer) {
	posix := []struct {
		cn, desc string
		gid      int
		uids     []string
	}{
		{"unix-staff", "Unix group of the staff", 2001, []string{"ada", "alan", "grace"}},
		{"unix-devs", "Unix group of the developers", 2002, []string{"ada", "margaret", "ghost.user", "twin", "casey"}},
		{"unix-empty", "Unix group with no member yet", 2003, nil},
	}
	for _, g := range posix {
		lines := []string{"objectClass: posixGroup", "objectClass: top", "cn: " + g.cn, "description: " + g.desc, fmt.Sprintf("gidNumber: %d", g.gid)}
		for _, u := range g.uids {
			lines = append(lines, "memberUid: "+u)
		}
		entry(w, "cn="+g.cn+",ou=groups,"+base, lines...)
	}
}

func writeServices(w *bufio.Writer) {
	for _, s := range []struct{ uid, desc, pw string }{
		{"svc-kanopa", "Kanopa read-only service account", readerPassword},
		{"svc-backup", "Nightly directory backup", servicePasswd},
		{"svc-mail", "Mail server address lookups", servicePasswd},
	} {
		entry(w, "uid="+s.uid+",ou=services,"+base, "objectClass: account", "objectClass: simpleSecurityObject", "objectClass: top",
			"uid: "+s.uid, "description: "+s.desc, "userPassword: "+ssha(s.pw))
	}
}

func writeHosts(w *bufio.Writer) {
	hosts := []struct{ cn, desc, ip string }{
		{"web01", "Public web server", "10.0.4.11"},
		{"db01", "Primary database server", "10.0.4.21"},
	}
	for i := len(hosts); i < hostsTotal; i++ {
		kind := []string{"app", "cache", "build", "mail", "file", "print"}[i%6]
		hosts = append(hosts, struct{ cn, desc, ip string }{
			fmt.Sprintf("%s%02d", kind, i), "Internal " + kind + " server", fmt.Sprintf("10.0.%d.%d", 5+i/50, 10+i%50)})
	}
	for _, h := range hosts {
		entry(w, "cn="+h.cn+",ou=hosts,"+base, "objectClass: device", "objectClass: ipHost", "objectClass: top",
			"cn: "+h.cn, "description: "+h.desc, "ipHostNumber: "+h.ip)
	}
}

// writeEdge writes ou=edge: entries that stress names, values and depth the way real directories do.
func writeEdge(w *bufio.Writer) {
	edge := "ou=edge," + base
	ou(w, "edge", "Awkward names, values and depth")

	person := func(rdn string, lines ...string) {
		entry(w, rdn+","+edge, append([]string{"objectClass: inetOrgPerson", "objectClass: top"}, lines...)...)
	}
	// Characters that must be escaped in a DN.
	person(`cn=Smith\, John`, `cn: Smith, John`, "sn: Smith", "givenName: John")
	person(`cn=Plus\+Equals\=Hash\#`, `cn: Plus+Equals=Hash#`, "sn: Characters")
	// A multi-valued RDN.
	person("cn=Twin+uid=twin", "cn: Twin", "uid: twin", "sn: Twin")
	person("cn=Twin two", "uid: twin", "sn: Twin")
	// A posixAccount named by cn: its uid is an attribute, not the RDN.
	person("cn=Casey Unix", "objectClass: posixAccount", "uid: casey", "sn: Unix", "uidNumber: 3001", "gidNumber: 2002", "homeDirectory: /home/casey")
	// Non-ASCII values and a long value.
	person("cn=Zoe Mueller", "sn: Müller", "givenName: Zoë", "description: Ærø, naïve café, 日本語")
	person("cn=Long description", "sn: Long", "description: "+strings.Repeat("A long sentence that keeps going. ", 120))
	// An attribute with many values, and a binary one.
	mails := []string{"sn: Many"}
	for i := 1; i <= 80; i++ {
		mails = append(mails, fmt.Sprintf("mail: many.%02d@example.org", i))
	}
	person("cn=Many values", mails...)
	person("cn=With photo", "sn: Photo", "jpegPhoto:: "+base64.StdEncoding.EncodeToString(photo()))

	// Depth: eight units nested.
	dn := edge
	for i := 1; i <= 8; i++ {
		dn = fmt.Sprintf("ou=level%d,%s", i, dn)
		entry(w, dn, "objectClass: organizationalUnit", "objectClass: top", fmt.Sprintf("ou: level%d", i))
	}
}
