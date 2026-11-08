package ldapx

import (
	"context"
	"errors"
	"fmt"

	ber "github.com/go-asn1-ber/asn1-ber"
	"github.com/go-ldap/ldap/v3"
)

// OIDs of what Kanopa looks for in the root DSE before it writes.
const (
	ControlTypeAssertion = "1.3.6.1.1.12"            // RFC 4528
	ExtPasswordModify    = "1.3.6.1.4.1.4203.1.11.1" // RFC 3062
)

// ControlAssertion makes the server apply an operation only while the entry matches a filter
// (RFC 4528). go-ldap does not ship it.
type ControlAssertion struct {
	Filter string
	packet *ber.Packet
}

// NewControlAssertion compiles filter; the control is always critical.
func NewControlAssertion(filter string) (*ControlAssertion, error) {
	p, err := ldap.CompileFilter(filter)
	if err != nil {
		return nil, err
	}
	return &ControlAssertion{Filter: filter, packet: p}, nil
}

// GetControlType returns the OID.
func (c *ControlAssertion) GetControlType() string { return ControlTypeAssertion }

// Encode returns the control as BER: type, criticality, then the filter wrapped in an octet string.
func (c *ControlAssertion) Encode() *ber.Packet {
	packet := ber.Encode(ber.ClassUniversal, ber.TypeConstructed, ber.TagSequence, nil, "Control")
	packet.AppendChild(ber.NewString(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, ControlTypeAssertion, "Control Type (Assertion)"))
	packet.AppendChild(ber.NewBoolean(ber.ClassUniversal, ber.TypePrimitive, ber.TagBoolean, true, "Criticality"))
	value := ber.Encode(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, nil, "Control Value (Assertion)")
	value.AppendChild(c.packet)
	packet.AppendChild(value)
	return packet
}

// String returns a human-readable description.
func (c *ControlAssertion) String() string {
	return fmt.Sprintf("Control Type: Assertion (%q)  Criticality: true  Filter: %s", ControlTypeAssertion, c.Filter)
}

// ModOp is one kind of modification.
type ModOp int

const (
	ModAdd ModOp = iota
	ModDelete
	ModReplace
)

// Mod is one modification of one attribute. A ModDelete without values removes the attribute.
type Mod struct {
	Op     ModOp
	Attr   string
	Values [][]byte
}

// Modify applies mods to dn in one request. A non-empty assertion filter is sent as a critical
// assertion control, so the server refuses (122) when the entry no longer matches.
func (s *Session) Modify(ctx context.Context, dn string, mods []Mod, assertion string) error {
	op := Op{Endpoint: s.Endpoint, Security: s.Security, BindDN: s.BindDN, Timeout: s.Timeout, Stage: StageWrite}
	var controls []ldap.Control
	if assertion != "" {
		c, err := NewControlAssertion(assertion)
		if err != nil {
			return fmt.Errorf("assertion filter %q: %w", assertion, err)
		}
		controls = append(controls, c)
	}
	req := ldap.NewModifyRequest(dn, controls)
	for _, m := range mods {
		vals := make([]string, len(m.Values))
		for i, v := range m.Values {
			vals[i] = string(v)
		}
		switch m.Op {
		case ModAdd:
			req.Add(m.Attr, vals)
		case ModDelete:
			req.Delete(m.Attr, vals)
		case ModReplace:
			req.Replace(m.Attr, vals)
		}
	}
	err := withCtx(ctx, s.Conn, func() error { return s.Conn.Modify(req) })
	return Classify(err, op).orNil()
}

// PasswordModify sets the password of dn with the Password Modify operation (RFC 3062), so the
// server hashes it under its own policy.
func (s *Session) PasswordModify(ctx context.Context, dn, password string) error {
	if password == "" {
		// An empty new password asks the server to generate one, which Kanopa never wants.
		return errors.New("enter the new password")
	}
	op := Op{Endpoint: s.Endpoint, Security: s.Security, BindDN: s.BindDN, Timeout: s.Timeout, Stage: StageWrite}
	err := withCtx(ctx, s.Conn, func() error {
		_, err := s.Conn.PasswordModify(ldap.NewPasswordModifyRequest(dn, "", password))
		return err
	})
	return Classify(err, op).orNil()
}

// withCtx runs one request, closing the connection if ctx ends first so the request returns.
func withCtx(ctx context.Context, c *ldap.Conn, f func() error) error {
	stop := context.AfterFunc(ctx, func() { c.Close() })
	defer stop()
	err := f()
	if err != nil && ctx.Err() != nil {
		return errors.Join(ctx.Err(), err)
	}
	return err
}

// orNil keeps a nil *Error from turning into a non-nil error interface.
func (e *Error) orNil() error {
	if e == nil {
		return nil
	}
	return e
}

// EscapeFilter escapes a value for use in a search or assertion filter (RFC 4515).
func EscapeFilter(v string) string { return ldap.EscapeFilter(v) }
