#!/usr/bin/env bash
# N6PhO: install your own relay (coturn) on a fresh Ubuntu server, e.g. Oracle Cloud Always Free.
#
#   curl -fsSLO https://YOU.github.io/n6pho/relay/setup-coturn.sh
#   sudo bash setup-coturn.sh https://YOU.github.io/n6pho/
#
# At the end it prints a link. Open it on your phone and N6PhO saves the relay.
# Also open these ports in your cloud provider's firewall (on Oracle: the subnet's Security List):
#   UDP 3478, TCP 3478, UDP 49160-49999
set -euo pipefail

APP_URL="${1:-}"
if [ "$(id -u)" -ne 0 ]; then echo "Run with sudo: sudo bash $0 $APP_URL"; exit 1; fi

echo "Installing coturn…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y >/dev/null
apt-get install -y coturn curl openssl >/dev/null

SECRET="$(openssl rand -hex 24)"
PUBLIC_IP="$(curl -fsS4 https://api.ipify.org || curl -fsS4 https://ifconfig.me)"
PRIVATE_IP="$(hostname -I | awk '{print $1}')"
if [ -z "$PUBLIC_IP" ]; then echo "Couldn't find this server's public IP."; exit 1; fi

cat > /etc/turnserver.conf <<CONF
# N6PhO relay
listening-port=3478
fingerprint
use-auth-secret
static-auth-secret=${SECRET}
realm=n6pho
external-ip=${PUBLIC_IP}/${PRIVATE_IP}
min-port=49160
max-port=49999
no-cli
no-tls
no-dtls
no-multicast-peers
stale-nonce=600
total-quota=60
# Never relay into private networks (keeps the server from being used to reach its own network).
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
CONF

if [ -f /etc/default/coturn ]; then
  sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
fi

echo "Opening the server's own firewall…"
if command -v ufw >/dev/null && ufw status | grep -q active; then
  ufw allow 3478/udp; ufw allow 3478/tcp; ufw allow 49160:49999/udp
fi
# Oracle's Ubuntu images block traffic with iptables rules, so add ours ahead of them.
iptables -I INPUT -p udp --dport 3478 -j ACCEPT
iptables -I INPUT -p tcp --dport 3478 -j ACCEPT
iptables -I INPUT -p udp --dport 49160:49999 -j ACCEPT
if command -v netfilter-persistent >/dev/null; then netfilter-persistent save >/dev/null || true; fi

systemctl enable coturn >/dev/null 2>&1 || true
systemctl restart coturn

JSON="{\"t\":\"coturn\",\"urls\":[\"turn:${PUBLIC_IP}:3478?transport=udp\",\"turn:${PUBLIC_IP}:3478?transport=tcp\"],\"secret\":\"${SECRET}\"}"
CODE="$(printf '%s' "$JSON" | base64 -w0 | tr '+/' '-_' | tr -d '=')"

echo
echo "Your relay is running at ${PUBLIC_IP}:3478"
echo
if [ -n "$APP_URL" ]; then
  case "$APP_URL" in */) ;; *) APP_URL="${APP_URL}/" ;; esac
  echo "Open this link on your phone to save it in N6PhO:"
  echo "  ${APP_URL}#relay=${CODE}"
else
  echo "In N6PhO → Your relay → Your own server, enter:"
  echo "  Address: turn:${PUBLIC_IP}:3478"
  echo "  Secret:  ${SECRET}"
fi
echo
echo "Keep that link/secret private: it lets the app make logins for your relay."
echo "Remember to open UDP 3478, TCP 3478 and UDP 49160-49999 in your cloud firewall too."
