# Kanopa's test directory: OpenLDAP with the design's sample data,
# plain + StartTLS on 389 and LDAPS on 636, signed by a throwaway CA.
FROM alpine:3.24

RUN apk add --no-cache openldap openldap-back-mdb openldap-clients openssl

# A test CA and a server certificate for localhost. Never trusted by the system.
RUN mkdir -p /etc/openldap/tls && cd /etc/openldap/tls \
 && openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=Kanopa Test CA" \
      -keyout ca.key -out ca.crt \
 && openssl req -newkey rsa:2048 -nodes -subj "/CN=localhost" -keyout server.key -out server.csr \
 && printf "subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n" > ext.cnf \
 && openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 3650 \
      -extfile ext.cnf -out server.crt \
 && rm -f ca.key server.csr ext.cnf ca.srl \
 && chown -R ldap:ldap /etc/openldap/tls && chmod 600 server.key

COPY slapd.conf /etc/openldap/slapd.conf
COPY seed.ldif /tmp/seed.ldif

ARG ADMIN_PASSWORD=kanopa-admin
RUN sed -i "s|@ROOTPW@|$(slappasswd -s "$ADMIN_PASSWORD")|" /etc/openldap/slapd.conf \
 && mkdir -p /var/lib/openldap/openldap-data /run/openldap \
 && slapadd -f /etc/openldap/slapd.conf -l /tmp/seed.ldif \
 && chown -R ldap:ldap /var/lib/openldap /run/openldap \
 && rm /tmp/seed.ldif

# kanopa-search <dn>: the entry as the server holds it, for comparing with Kanopa by hand.
RUN printf '#!/bin/sh\nexec ldapsearch -LLL -o ldif-wrap=no -x -H ldap://localhost -D cn=admin,dc=example,dc=org -w "%s" -b "$1" -s base "*" "+"\n' "$ADMIN_PASSWORD" \
      > /usr/local/bin/kanopa-search && chmod +x /usr/local/bin/kanopa-search

EXPOSE 389 636
CMD ["slapd", "-d", "256", "-u", "ldap", "-g", "ldap", "-h", "ldap:/// ldaps:///", "-f", "/etc/openldap/slapd.conf"]
