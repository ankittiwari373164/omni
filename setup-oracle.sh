#!/usr/bin/env bash
# setup-oracle.sh — one-time setup for Oracle Cloud Always Free VM
# Works on Ubuntu 22.04 ARM (Ampere A1) or x86
set -e

echo "==> [1/5] Adding 4GB swap"
if [ ! -f /swapfile ]; then
  sudo fallocate -l 4G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
fi
sudo sysctl vm.swappiness=10 || true
free -h

echo "==> [2/5] Installing Node 22, ffmpeg, xvfb, git"
sudo apt-get update -q
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - -q
sudo apt-get install -y nodejs ffmpeg xvfb git

echo "==> [3/5] Cloning repo"
cd "$HOME"
if [ ! -d omni ]; then
  git clone https://github.com/ankittiwari373164/omni.git
fi
cd omni

echo "==> [4/5] Installing deps + Chromium"
npm ci --omit=dev
npx playwright install --with-deps chromium

echo "==> [5/5] Creating .env + run script + cron"
if [ ! -f .env ]; then
  cat > .env << 'EOF'
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
GROQ_API_KEY=
GROQ_MODEL=llama-3.3-70b-versatile
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=
FLOW_RECAPTCHA_KEY=6LdsFiUsAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV
WORKER_MAX_VIDEOS=4
EOF
  echo "--> Fill in secrets: nano ~/omni/.env"
fi

cat > "$HOME/omni/run-worker.sh" << 'EOF'
#!/usr/bin/env bash
cd "$HOME/omni"
git pull --quiet || true
echo "[$(date)] worker starting" >> worker.log
xvfb-run --auto-servernum --server-args="-screen 0 1280x800x24" node worker.js >> worker.log 2>&1
echo "[$(date)] worker done ($?)" >> worker.log
EOF
chmod +x "$HOME/omni/run-worker.sh"

# Cron: 8:00 AM IST = 02:30 UTC
( crontab -l 2>/dev/null | grep -v run-worker ; echo "30 2 * * * $HOME/omni/run-worker.sh" ) | crontab -

echo ""
echo "✅ Done. Next steps:"
echo "  1) nano ~/omni/.env        ← fill in your secrets"
echo "  2) ~/omni/run-worker.sh    ← test one run"
echo "  3) tail -f ~/omni/worker.log"