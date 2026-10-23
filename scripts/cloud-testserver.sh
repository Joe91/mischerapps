#!/usr/bin/env bash
# Starts a local OpenCloud (Docker) set up like the real one: the user "owner" shares a folder "Predigten" with the
# user "jo" (may edit), and jo creates an app token. Prints the values for the app: the "cloud" section of
# config.json, or the variables for `npm run dev`.
# Stop with: docker rm -f predigt-opencloud
set -euo pipefail
NAME=predigt-opencloud
DIR="${TMPDIR:-/tmp}/predigt-opencloud"
B=https://localhost:9200
JO_PW='Jo-Test-2026!'
mkdir -p "$DIR/config" "$DIR/data"
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run --rm -v "$DIR/config:/etc/opencloud" -v "$DIR/data:/var/lib/opencloud" -e IDM_ADMIN_PASSWORD=admin \
  opencloudeu/opencloud-rolling:latest init --insecure true --force-overwrite >/dev/null
# basic auth only for the setup below; the app itself logs in with the app token (works without it as well)
docker run -d --name "$NAME" -p 9200:9200 -v "$DIR/config:/etc/opencloud" -v "$DIR/data:/var/lib/opencloud" \
  -e OC_INSECURE=true -e OC_URL=$B -e PROXY_TLS=true -e PROXY_ENABLE_BASIC_AUTH=true \
  opencloudeu/opencloud-rolling:latest server >/dev/null
adm() { curl -sk -u admin:admin "$@"; }
jo() { curl -sk -u "jo:$JO_PW" "$@"; }
json() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
echo -n "Warte auf OpenCloud "
for _ in $(seq 1 60); do
  [ "$(curl -sk -o /dev/null -w '%{http_code}' -u admin:admin $B/graph/v1.0/me/drive)" = 200 ] && break
  echo -n .; sleep 2
done
echo

JO_ID=$(adm -H 'Content-Type: application/json' -X POST $B/graph/v1.0/users \
  -d "{\"onPremisesSamAccountName\":\"jo\",\"displayName\":\"Jo\",\"mail\":\"jo@example.org\",\"passwordProfile\":{\"password\":\"$JO_PW\"}}" | json "d['id']")
DAV=$(adm $B/graph/v1.0/me/drive | json "d['root']['webDavUrl']")
DRIVE=${DAV##*/}
adm -X MKCOL "$DAV/Predigten" -o /dev/null
FOLDER=$(adm -X PROPFIND -H 'Depth: 0' "$DAV/Predigten" | grep -o '<oc:id>[^<]*' | cut -d'>' -f2)
# role "Can edit" (Editor)
adm -H 'Content-Type: application/json' -X POST "$B/graph/v1beta1/drives/$DRIVE/items/$FOLDER/invite" \
  -d "{\"recipients\":[{\"objectId\":\"$JO_ID\",\"@libre.graph.recipient.type\":\"user\"}],\"roles\":[\"fb6c3e19-e378-47e5-b277-9732f9de6e21\"]}" >/dev/null
SHARE=""
for _ in $(seq 1 10); do
  SHARE=$(jo $B/graph/v1beta1/me/drive/sharedWithMe | json "d['value'][0]['id'] if d['value'] else ''")
  [ -n "$SHARE" ] && break
  sleep 1
done
URL="$B/dav/spaces/$SHARE/"
TOKEN=$(jo -X POST -H 'accept: application/json' "$B/auth-app/tokens?expiry=720h" | json "d['token']")

cat <<INFO

OpenCloud läuft: $B  (admin / admin, jo / $JO_PW – Zertifikatswarnung im Browser einmal bestätigen)
Ordner "Predigten" von admin, für jo freigegeben (darf bearbeiten). App-Token von jo, 30 Tage gültig.

config.json:
  "cloud": { "url": "$URL", "user": "jo", "token": "$TOKEN" }

npm run dev (selbstsigniertes Zertifikat, nur zum Testen):
  NODE_TLS_REJECT_UNAUTHORIZED=0 CLOUD_URL='$URL' CLOUD_USER=jo CLOUD_TOKEN='$TOKEN' npm run dev
INFO
