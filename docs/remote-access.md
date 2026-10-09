# Remote access: options and open decision

Status: **undecided.** We'll revisit this when we start Phase 3 (remote control). This file records the options and trade-offs discussed on 2026-10-09, so the decision can be made later without redoing the research.

## Goal

Use the dashboard from a phone or another computer to see sessions, approve permission prompts, type into terminals, and get notified when a session needs you or finishes a turn.

## What any solution must satisfy

Anyone who reaches the hub with valid credentials can type into Claude Code, and Claude Code can run shell commands. So remote access is effectively remote shell access, and it must provide:

1. **Reach.** The viewer can get to the machine from anywhere, not just the home network.
2. **Encryption.** Tokens, transcripts and keystrokes never travel in plain text.
3. **No exposure.** Strangers on the internet or the same Wi-Fi can't reach anything. The hub keeps listening on `127.0.0.1` only, so there is never an open inbound port (see CLAUDE.md).
4. **HTTPS.** Web Push notifications need a secure context. On iPhone, web push also requires the site to be added to the Home Screen.

## Constraint: machines we don't control

**Tailscale (or any VPN client) may not be installable on some machines that run the hub**, for example managed work machines where installing software or network extensions isn't allowed. A solution that only works where Tailscale is installed can't be the only option.

Related considerations for such machines:
- **Outbound connections may be restricted too.** A corporate proxy or firewall may block WebSockets or unknown domains, so an outbound relay connection isn't guaranteed to work either.
- **Policy.** Remote control of a managed machine may conflict with the organization's rules. Check before enabling it there.
- **Hub prerequisites.** Even the hub needs Node.js and tmux. On a locked-down machine those may need to come from a user-level install (no admin rights).

## Options

### A. Tailscale + `tailscale serve`
A private network of your own devices (a "tailnet", built on WireGuard). `tailscale serve` gives the machine a private HTTPS address (`https://<machine>.<tailnet>.ts.net`) that forwards to `127.0.0.1:7777`, and only tailnet devices can open it.

- **Pros:**
  - Works anywhere and gets through NAT without router changes.
  - The hub stays local-only.
  - Real HTTPS certificate, so push notifications work.
  - Almost no networking code in Control-C: allow the `.ts.net` host and origin, set a Secure cookie, and add phone pairing.
  - Free for personal use, and already installed on the main Mac.
- **Cons:**
  - Needs the Tailscale app on every device, so **it isn't possible on machines where we can't install it.**
  - Needs a Tailscale account. It manages device membership but can't read traffic.
  - iPhone allows only one VPN at a time.
- **Effort:** small, about a day.

### B. Custom relay: Cloudflare Worker + Supabase Auth + end-to-end encryption
```
Phone (browser/PWA) ──HTTPS/WSS──▶ Cloudflare Worker (relay) ◀──WSS, outbound── machine: hub + Claude Code
                         ▲
                Supabase Auth (identity)
```
The hub connects **out** to the Worker and keeps the connection open. The phone connects to the Worker, and the Worker joins the two connections (Durable Objects hold the WebSocket pairs).

- **Pros:**
  - Nothing to install on the viewer device: it's a normal website.
  - On the hub machine, it needs only an outbound HTTPS/WSS connection, **so it can work where Tailscale can't be installed.** That's subject to the outbound restrictions above.
  - Real login (magic link, passkeys).
  - Supports several machines and possibly other users.
  - The Worker can send push notifications, queue messages while a machine is asleep, and later serve Phase 4 agent-to-agent traffic.
  - Fits the Supabase and Cloudflare stack the owner already uses.
- **Cons:**
  - The relay is a **public endpoint that ultimately leads to a shell**, so every safeguard is our own code.
  - About the size of Phases 1 and 2 combined.
  - Adds latency for terminal streaming.
  - Durable Objects have usage-based pricing, so check current plans.
  - Deploys and maintenance.

**Security requirements if we build it:**
- **The Worker is untrusted by design.** If the Worker, the Cloudflare account or the Supabase project were compromised, the worst outcome should be "can't connect", never "can control the machine".
- **Login alone isn't enough: device pairing.** Each viewer device generates its own key pair and is approved once by scanning a QR code shown by the hub. The hub only accepts messages signed by paired devices. Supabase answers "who are you"; pairing answers "is this one of my devices".
- **End-to-end encryption between viewer and hub, using standard primitives only.**
  - Use X25519 key exchange with AES-GCM (WebCrypto in the browser, `node:crypto` in the hub), or an established protocol such as Noise.
  - No homemade schemes.
  - Cover replay protection, key rotation, and revoking a lost device.
- **The Worker only ever forwards ciphertext.** TLS alone isn't enough, because the Worker would see plaintext.

### C. Other options (considered, not preferred)

| Option | Why not (as the main solution) |
|---|---|
| Listen on the LAN (`192.168.x.x`) | Home network only, plain HTTP (token can be sniffed), any device on the Wi-Fi can reach it, no push notifications. Acceptable only for a quick home test. |
| SSH tunnel | Strong and keeps the hub local, but remote use means exposing SSH on the router, and phones handle tunnels poorly (iOS kills them in the background). Good from a laptop. May also be blocked on managed machines. |
| Router port forwarding | Exposes the machine to the whole internet behind one token. Rejected ("never an open port"). |
| Cloudflare Tunnel / ngrok | Public HTTPS address without router changes, but needs an extra login layer (e.g. Cloudflare Access), traffic is decrypted at their edge, and Cloudflare Tunnel needs your own domain. A possible stepping stone toward option B. |
| ZeroTier / self-hosted WireGuard / Headscale | Same idea as Tailscale, so the same install limitation, plus more setup. |

## Leaning (not a decision)

The suggestion on the table was **both, in stages:**
1. Tailscale first, where it can be installed, to get remote use and notifications working quickly and learn what the phone UI needs.
2. Build the pieces that carry over to any transport: phone pairing with a QR code, a Secure cookie, the phone layout, notifications (in-page, then Web Push).
3. Make "how a viewer connects" a swappable layer in the hub (local / Tailscale / relay).
4. Build the Cloudflare + Supabase relay (option B) for machines where Tailscale isn't possible, starting with a short design doc covering the pairing flow, the encryption, and what each component can see.

**The Tailscale constraint above makes option B (or something like it) necessary eventually**, unless every machine that matters allows Tailscale.

## Open questions for when we revisit
- Which machines will run the hub, and which of them allow installing Tailscale, Node.js and tmux?
- Do those machines allow outbound WebSocket connections to a Cloudflare domain?
- Is remote control of a work machine allowed by its policy?
- Single user only, or might other people use it later? This affects whether Supabase is worth it.
- Is a ~$5/month Cloudflare plan acceptable if Durable Objects need it?
