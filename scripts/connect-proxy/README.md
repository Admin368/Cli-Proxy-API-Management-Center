# Connect an EasyCLIProxyAPI installation to another machine

Copy this whole folder to each Windows machine and double-click `Connect-Proxy.cmd`.
Windows PowerShell 5.1 is sufficient; no extra modules are needed.
Start the local EasyCLIProxyAPI core first. Run from its folder or supply the folder
containing config.yaml when prompted. The folder is only used to suggest the port;
configuration is persisted and hot-reloaded through the running v8 Management API.

The wizard checks online Tailscale peers and known Windows LAN neighbors on your
chosen port (default 8317). TCP checks run concurrently; HTTP identification takes
up to two seconds per open endpoint. An optional private LAN /24 sweep finds devices
missing from the neighbor cache. HTTPS, other ports and undiscovered machines can
be entered manually. Discovery only suggests servers whose root endpoint identifies
CLI Proxy API; authenticated model discovery validates the selected source.

You need the source's **client API key** and the local **management key**. Input is
masked. The source must listen on its LAN/Tailscale interface and permit the port
through its firewall. Remote management on the source is not required. Use HTTPS
on untrusted LANs; HTTP LAN traffic is unencrypted. Tailscale transport is encrypted.

The wizard adds/replaces only the provider named `network-main`. Choose a model
named `main/<model>` in your client to route through it. Existing providers remain
available. Provider credentials stay on the source; only its client key is stored
in the local core config. This is forwarding, not credential/config replication,
and protocol-specific native features are not guaranteed through OpenAI compatibility.
Do not configure source machines to forward back to their downstream machines.

Rerun to switch machines or refresh the model list; it is not continuously synced.
Remove `network-main` in the management UI to undo. No live settings are changed
until you type APPLY. Do not concurrently edit providers during setup (the API has
no atomic compare-and-swap). A timeout during saving can mean the change succeeded;
inspect the provider in the UI before retrying. Keys are never printed in errors.

Validation: `powershell -NoProfile -File scripts/connect-proxy/Test-Connect-Proxy.ps1`.
