#!/bin/bash
# Enables HTTPS for the PDF Reader update folder on the update server.
# Run once on the server as root:  sudo bash server-https.sh
#
# - Self-signed certificate for the server's IP (a public CA cannot issue one
#   for a private address). The app pins this exact certificate, so client
#   PCs need nothing installed.
# - A new :443 virtual host serves /pdf-reader/ only; the sites on :80 are
#   left untouched.
# - Safe to run again: an existing key/certificate is kept (re-creating it
#   would break the pin in every installed app).

set -euo pipefail

IP=192.168.0.44
CERT_DIR=/etc/ssl/pdf-reader
WEB_DIR=/var/www/html/pdf-reader
EMPTY_ROOT=/var/www/pdf-reader-ssl-root
SITE=/etc/apache2/sites-available/pdf-reader-ssl.conf

[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }

mkdir -p "$CERT_DIR" "$EMPTY_ROOT"
chmod 700 "$CERT_DIR"
if [ ! -f "$CERT_DIR/server.key" ]; then
    openssl req -x509 -nodes -days 3650 \
        -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
        -keyout "$CERT_DIR/server.key" -out "$CERT_DIR/server.crt" \
        -subj "/CN=$IP/O=PDF Reader update server" \
        -addext "subjectAltName=IP:$IP" \
        -addext "basicConstraints=critical,CA:FALSE" \
        -addext "keyUsage=critical,digitalSignature" \
        -addext "extendedKeyUsage=serverAuth"
    chmod 600 "$CERT_DIR/server.key"
    echo "created certificate $CERT_DIR/server.crt"
else
    echo "keeping existing certificate $CERT_DIR/server.crt"
fi

cat > "$SITE" <<EOF
# PDF Reader update folder over HTTPS (tools/server-https.sh in the pdf-reader repo).
<VirtualHost *:443>
    ServerName $IP
    DocumentRoot $EMPTY_ROOT
    Alias /pdf-reader/ $WEB_DIR/
    <Directory $WEB_DIR>
        Options None
        AllowOverride None
        Require all granted
    </Directory>
    SSLEngine on
    SSLCertificateFile $CERT_DIR/server.crt
    SSLCertificateKeyFile $CERT_DIR/server.key
    SSLProtocol -all +TLSv1.2 +TLSv1.3
    ErrorLog \${APACHE_LOG_DIR}/pdf-reader-ssl-error.log
    CustomLog \${APACHE_LOG_DIR}/pdf-reader-ssl-access.log combined
</VirtualHost>
EOF

a2enmod -q ssl
a2ensite -q pdf-reader-ssl
apache2ctl configtest
# Graceful: requests in progress on the other sites finish normally.
systemctl reload apache2
sleep 2
if ! ss -ltn | grep -q ':443 '; then
    echo "port 443 not listening after reload, restarting apache2"
    systemctl restart apache2
fi

if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then
    ufw allow 443/tcp
fi

ss -ltn | grep ':443 '
echo "certificate SHA-256 fingerprint:"
openssl x509 -in "$CERT_DIR/server.crt" -noout -fingerprint -sha256
