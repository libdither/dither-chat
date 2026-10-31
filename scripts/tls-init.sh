#!/usr/bin/env sh
# Private CA and server certificate for serving the hub over HTTPS on a tailnet.
#
#   scripts/tls-init.sh <data-dir> <dns-name> <ip>...
#
# The CA is name-constrained to the tailnet, so even a leaked key cannot impersonate
# anything else to a device that trusts it. Re-running keeps the CA, so devices stay
# trusted, and issues a new server certificate. Nothing here belongs in git.
set -eu
[ $# -ge 2 ] || { echo "usage: $0 <data-dir> <dns-name> [ip...]" >&2; exit 2; }
dir="$1/tls"; dns="$2"; shift 2
parent="${dns#*.}"
umask 077
mkdir -p "$dir"
chmod 700 "$dir"

if [ ! -f "$dir/ca.key" ]; then
  openssl ecparam -name prime256v1 -genkey -noout -out "$dir/ca.key"
  # Permitted names: the tailnet's domain and Tailscale's address ranges.
  openssl req -x509 -new -key "$dir/ca.key" -sha256 -days 3650 -out "$dir/ca.crt" \
    -subj "/O=dither-chat/CN=dither-chat private CA ($dns)" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -addext "nameConstraints=critical,permitted;DNS:$parent,permitted;IP:100.64.0.0/255.192.0.0,permitted;IP:fd7a:115c:a1e0:0:0:0:0:0/ffff:ffff:ffff:0:0:0:0:0"
fi

san="DNS:$dns"
for ip in "$@"; do san="$san,IP:$ip"; done

openssl ecparam -name prime256v1 -genkey -noout -out "$dir/server.key"
openssl req -new -key "$dir/server.key" -subj "/CN=$dns" -out "$dir/server.csr"
ext="$dir/server.ext"
cat > "$ext" <<EXT
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=serverAuth
subjectAltName=$san
EXT
# 397 days is the longest a browser accepts for a server certificate.
openssl x509 -req -in "$dir/server.csr" -CA "$dir/ca.crt" -CAkey "$dir/ca.key" -CAcreateserial \
  -days 397 -sha256 -extfile "$ext" -out "$dir/server.crt" 2>/dev/null
rm -f "$dir/server.csr" "$ext"
chmod 600 "$dir/ca.key" "$dir/server.key"
chmod 644 "$dir/ca.crt" "$dir/server.crt"
openssl x509 -in "$dir/ca.crt" -noout -fingerprint -sha256
openssl x509 -in "$dir/server.crt" -noout -enddate -ext subjectAltName
