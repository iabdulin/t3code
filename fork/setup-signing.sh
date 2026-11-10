#!/bin/bash
# Creates a local, self-signed code-signing identity for "My T3 Code" builds.
#
# Ad-hoc builds get a new signature identity whenever the binary changes, so macOS
# forgets Keychain "Always Allow" and privacy permissions. Signing every build with
# the same certificate keeps the app's identity stable.
#
# The key lives in its own keychain (my-t3code-signing) so codesign can use it from
# the nightly job without a password dialog. That keychain's password is stored in
# the updater's state directory, readable only by this user. The certificate is not
# trusted by macOS and is no use for distributing the app to other machines.
#
# Safe to run again: it keeps an existing identity.
set -euo pipefail

IDENTITY="My T3 Code Local Signing"
STATE_DIR="$HOME/Library/Application Support/my-t3code-nightly"
KEYCHAIN="$HOME/Library/Keychains/my-t3code-signing.keychain-db"
PASSWORD_FILE="$STATE_DIR/signing-keychain-password"

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"

if [[ -f "$KEYCHAIN" && -f "$PASSWORD_FILE" ]] &&
  security find-certificate -c "$IDENTITY" "$KEYCHAIN" >/dev/null 2>&1; then
  echo "Signing identity \"$IDENTITY\" already exists."
  exit 0
fi
if [[ -f "$KEYCHAIN" ]]; then
  echo "Found $KEYCHAIN without a usable identity. Remove it first: security delete-keychain \"$KEYCHAIN\"" >&2
  exit 1
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
umask 077

openssl rand -hex 24 > "$PASSWORD_FILE"
chmod 600 "$PASSWORD_FILE"
password=$(cat "$PASSWORD_FILE")

cat > "$work/cert.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $IDENTITY
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config "$work/cert.cnf" \
  -keyout "$work/key.pem" -out "$work/cert.pem" 2>/dev/null
# macOS `security` only reads the older PKCS#12 encryption.
openssl pkcs12 -export -legacy -inkey "$work/key.pem" -in "$work/cert.pem" \
  -name "$IDENTITY" -out "$work/identity.p12" -passout "file:$PASSWORD_FILE"

security create-keychain -p "$password" "$KEYCHAIN"
security set-keychain-settings "$KEYCHAIN"
security unlock-keychain -p "$password" "$KEYCHAIN"
security import "$work/identity.p12" -k "$KEYCHAIN" -P "$password" -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$KEYCHAIN" >/dev/null

# Add the keychain to the user's search list, keeping the ones already there.
existing=()
while IFS= read -r line; do
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%\"}"
  line="${line#\"}"
  [[ -n "$line" && "$line" != "$KEYCHAIN" ]] && existing+=("$line")
done < <(security list-keychains -d user)
security list-keychains -d user -s "${existing[@]}" "$KEYCHAIN"

echo "Created signing identity \"$IDENTITY\" in $KEYCHAIN"
