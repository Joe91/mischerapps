#!/usr/bin/env bash
# Starts a local OpenCloud (Docker) with a shared "Predigten" folder for testing the cloud upload.
# Prints the share link and password to enter in the app (Einstellungen → Upload-Ziele).
# Stop with: docker rm -f predigt-opencloud
set -euo pipefail
NAME=predigt-opencloud
DIR="${TMPDIR:-/tmp}/predigt-opencloud"
PW='Predigt-Test-2026!'
B=https://localhost:9200
mkdir -p "$DIR/config" "$DIR/data"
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run --rm -v "$DIR/config:/etc/opencloud" -v "$DIR/data:/var/lib/opencloud" -e IDM_ADMIN_PASSWORD=admin \
  opencloudeu/opencloud-rolling:latest init --insecure true --force-overwrite >/dev/null
docker run -d --name "$NAME" -p 9200:9200 -v "$DIR/config:/etc/opencloud" -v "$DIR/data:/var/lib/opencloud" \
  -e OC_INSECURE=true -e OC_URL=$B -e PROXY_TLS=true -e PROXY_ENABLE_BASIC_AUTH=true \
  -e OC_CORS_ALLOW_ORIGINS="http://localhost:5173,http://localhost:4173" \
  opencloudeu/opencloud-rolling:latest server >/dev/null
echo -n "Warte auf OpenCloud "
for _ in $(seq 1 60); do
  [ "$(curl -sk -o /dev/null -w '%{http_code}' -u admin:admin $B/graph/v1.0/me/drive)" = 200 ] && break
  echo -n .; sleep 2
done
echo
DAV=$(curl -sk -u admin:admin $B/graph/v1.0/me/drive | python3 -c "import json,sys; print(json.load(sys.stdin)['root']['webDavUrl'])")
DRIVE=${DAV##*/}
curl -sk -u admin:admin -X MKCOL "$DAV/Predigten" -o /dev/null
ID=$(curl -sk -u admin:admin -X PROPFIND -H 'Depth: 0' "$DAV/Predigten" | grep -o '<oc:id>[^<]*' | cut -d'>' -f2)
LINK=$(curl -sk -u admin:admin -H 'Content-Type: application/json' -X POST "$B/graph/v1beta1/drives/$DRIVE/items/$ID/createLink" \
  -d "{\"type\":\"edit\",\"password\":\"$PW\"}" | python3 -c "import json,sys; print(json.load(sys.stdin)['link']['webUrl'])")
cat <<INFO

OpenCloud läuft: $B  (Admin: admin / admin – Zertifikatswarnung im Browser einmal bestätigen!)
In der App unter Einstellungen → Upload-Ziele → + Ziel hinzufügen:
  Art:           Cloud-Ordner (OpenCloud)
  Freigabe-Link: $LINK
  Link-Passwort: $PW
Hochgeladene Dateien: $B → Ordner "Predigten"
INFO
