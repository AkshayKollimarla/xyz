# Deploying to AWS EC2

This gets the app reachable from anywhere (including your phone) over
HTTPS, gated by the login you configured in `.env`. Read the whole thing
before starting — steps 1-2 you do in the AWS/DuckDNS consoles yourself
(no AWS credentials are shared with anyone else for this); steps 3+ run on
the instance once it exists.

## 1. Create the EC2 instance (AWS Console)

1. EC2 → **Launch instance**.
2. Name: anything, e.g. `hyperliquid-withdraw`.
3. AMI: **Ubuntu Server 24.04 LTS**.
4. Instance type: **t3.micro** or **t4g.micro** — this workload is tiny,
   either is plenty (both are free-tier eligible for new AWS accounts).
5. Key pair: create a new one, download the `.pem` file, keep it safe —
   it's how you'll SSH in. There is no way to re-download it later.
6. Network settings → Edit security group rules:
   - **SSH (22)** — source: **My IP** (not "Anywhere"). This is how you
     manage the box; no reason to expose it publicly.
   - **HTTP (80)** — source: Anywhere (0.0.0.0/0). Needed for Let's
     Encrypt's certificate validation and to redirect to HTTPS.
   - **HTTPS (443)** — source: Anywhere (0.0.0.0/0). This is the actual
     public entry point to the app.
   - Do **not** add a rule for port 3001 (or any other app port) — the
     Node process only ever binds to `127.0.0.1` and is never meant to be
     reachable directly, only through Caddy on 443.
7. Storage: default (8 GB gp3) is fine.
8. Launch.
9. **Allocate an Elastic IP** and associate it with the instance (EC2 →
   Elastic IPs → Allocate → Associate). Without this, the public IP
   changes every time you stop/start the instance, which would break the
   DuckDNS hostname below. An Elastic IP is free as long as it's attached
   to a running instance.

## 2. Point a hostname at it (DuckDNS — free)

1. Go to [duckdns.org](https://www.duckdns.org), sign in (GitHub/Google/etc).
2. Add a subdomain, e.g. `yourname-hlwithdraw` → you get
   `yourname-hlwithdraw.duckdns.org`.
3. Set its IP to the Elastic IP from step 1.9.

DNS propagation is usually fast (minutes) but can occasionally take longer.

## 3. Set up the instance

SSH in (replace with your key path and Elastic IP):

```bash
ssh -i /path/to/your-key.pem ubuntu@YOUR_ELASTIC_IP
```

Install Node.js 20:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # sanity check
```

Install Caddy (automatic HTTPS reverse proxy):

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update
sudo apt-get install -y caddy
```

## 4. Deploy the app

```bash
git clone https://github.com/AkshayKollimarla/xyz.git
cd xyz/hyperliquid-usdc-withdraw
npm install
cp .env.example .env
nano .env   # fill in PRIVATE_KEY, PRIVATE_KEY_2, DESTINATION_ADDRESS, EXTRA_PERP_DEXES,
            # APP_PASSWORD, SESSION_SECRET — same values as your local .env, or fresh ones.
            # Generate SESSION_SECRET with:
            #   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**This `.env` is typed directly on the server — never send private keys
over SSH copy/paste from a source you don't trust, and never commit this
file.** It's already gitignored.

## 5. Configure Caddy (HTTPS)

```bash
sudo nano /etc/caddy/Caddyfile
```

Paste the contents of `deploy/Caddyfile.example` from this repo, replacing
the domain with your actual DuckDNS hostname. Then:

```bash
sudo systemctl reload caddy
```

Caddy will automatically request and renew the HTTPS certificate the first
time it sees a request for that domain.

## 6. Run the app as a service (survives reboots/crashes)

```bash
sudo cp deploy/hyperliquid-withdraw.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hyperliquid-withdraw
sudo systemctl status hyperliquid-withdraw
```

If the `User=`/`WorkingDirectory=` in the service file don't match your
actual username/clone path, edit `/etc/systemd/system/hyperliquid-withdraw.service`
accordingly before enabling it.

## 7. Test it

From your phone or any browser: `https://yourname-hlwithdraw.duckdns.org`

You should see the login screen. Log in with `APP_PASSWORD` from the
server's `.env`.

## Updating later

```bash
cd ~/xyz/hyperliquid-usdc-withdraw
git pull
npm install
sudo systemctl restart hyperliquid-withdraw
```

## Security checklist before you actually rely on this

- [ ] Security group only allows 22 (your IP), 80, 443 — nothing else
- [ ] `APP_PASSWORD` is long and random, not something guessable
- [ ] `SESSION_SECRET` is a real random value, not left blank
- [ ] `NODE_ENV=production` is set (the systemd unit sets this) — without
      it, session cookies aren't marked HTTPS-only
- [ ] You're accessing via `https://`, not `http://`
- [ ] The `.pem` SSH key file is kept somewhere safe, not in this repo
