#!/usr/bin/env bash
# Regenerate the local TLS chain for scripts/mcp-oauth-proxy.mjs.
#
# WHY A CA AND NOT JUST A SELF-SIGNED CERT
# ----------------------------------------
# Claude Code runs on Bun, which (like Node) ignores the Windows certificate store entirely.
# The only lever is NODE_EXTRA_CA_CERTS -- and that adds trusted *CAs*, not trusted leaves.
# A self-signed leaf (CA:FALSE) pointed at by NODE_EXTRA_CA_CERTS is still rejected with
# DEPTH_ZERO_SELF_SIGNED_CERT, which is exactly the wall this hit. So: a real CA that signs a
# real leaf.
#
#   ca-cert.pem     CA:TRUE, pathlen:0  <- the file NODE_EXTRA_CA_CERTS points at
#   proxy-cert.pem  CA:FALSE, SANs localhost/127.0.0.1/::1, signed by the CA  <- what we serve
#
# ⚠️ ca-key.pem can sign certificates for ANY host. It never leaves this machine, .certs/ is
# gitignored, and the CA is only trusted by processes given NODE_EXTRA_CA_CERTS. Do not copy it.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .certs && cd .certs
rm -f ./*.pem ./*.csr ./*.srl

cat > ca.cnf <<'CNF'
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = FFS Local Dev CA
[v3]
basicConstraints = critical,CA:TRUE,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
CNF

cat > leaf.cnf <<'CNF'
[req]
distinguished_name = dn
prompt = no
[dn]
CN = localhost
[v3]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt
[alt]
DNS.1 = localhost
IP.1  = 127.0.0.1
IP.2  = ::1
CNF

openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config ca.cnf \
  -keyout ca-key.pem -out ca-cert.pem
openssl req -new -newkey rsa:2048 -nodes -config leaf.cnf \
  -keyout proxy-key.pem -out leaf.csr
openssl x509 -req -in leaf.csr -CA ca-cert.pem -CAkey ca-key.pem -CAcreateserial \
  -days 3650 -extfile leaf.cnf -extensions v3 -out proxy-cert.pem
openssl verify -CAfile ca-cert.pem proxy-cert.pem

echo
echo "Point the client at the CA (Bun/Node ignore the Windows store):"
echo "  setx NODE_EXTRA_CA_CERTS \"$(pwd -W 2>/dev/null || pwd)/ca-cert.pem\""
