package services

import (
	"errors"

	"github.com/go-ldap/ldap/v3"
)

func ldapErr49() error { return ldap.NewError(49, errors.New("")) }
