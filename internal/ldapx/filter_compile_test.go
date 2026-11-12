package ldapx

import "github.com/go-ldap/ldap/v3"

func ldapCompile(f string) (any, error) { return ldap.CompileFilter(f) }
