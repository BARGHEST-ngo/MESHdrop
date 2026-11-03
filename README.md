# MESHdrop

Private file transfer between two computers. No cloud, no account, no trace. Built on [MESHnet](https://github.com/BARGHEST-ngo/MESHnet).

MESHdrop sends a file straight from one desktop to another, wherever they are. There's nothing to sign up for and no upload to a third-party service. The sender gets a link and a 6-digit PIN, shares them with the receiver, and the file goes across once the receiver accepts it.

> **Status: early alpha.** It works end to end, but it hasn't been widely tested.

## Installing

Download the build for your system from [Releases](https://github.com/BARGHEST-ngo/meshdrop/releases).

**Linux** needs WebKitGTK 6 installed. Many desktops already have it. If MESHdrop fails to start with `libwebkitgtk-6.0.so.4: cannot open shared object file`, install it:

| Distro | Command |
| --- | --- |
| Ubuntu 24.04+ / Debian 13+ | `sudo apt install libwebkitgtk-6.0-4` |
| Fedora | `sudo dnf install webkitgtk6.0` |
| Arch | `sudo pacman -S webkitgtk-6.0` |

Older distros, such as Ubuntu 22.04, don't have WebKitGTK 6 and can't run MESHdrop yet.

**macOS** will block MESHdrop the first time you open it, because the app isn't signed with an Apple Developer ID yet. To allow it:

1. Unzip the download, move `meshdrop.app` to Applications, and open it. macOS shows a warning and refuses to open the app.
2. Open **System Settings → Privacy & Security**, scroll down to the message about MESHdrop, and click **Open Anyway**.
3. Open MESHdrop again and confirm. You only need to do this once.

## How it works

**Sending**

1. Open MESHdrop, click **Send**, and pick a file.
2. MESHdrop shows a link and a PIN. Send both to the receiver. A chat message or a phone call is fine.
3. When they connect and accept, the file transfers. You'll see the progress and a confirmation when it arrives.

**Receiving**

1. Open MESHdrop and click **Receive**.
2. Paste the link, type the PIN, and connect.
3. MESHdrop shows the file's name and size. Click **Accept** to choose where to save it, or **Decline** to refuse it.

Each link and PIN works for a single transfer.

## Privacy

- **No accounts and no cloud storage.** The file is never uploaded anywhere. It streams from one machine to the other.
- **Encrypted end to end.** The connection is encrypted between the two computers. When a direct connection isn't possible, traffic passes through a relay, which can't read it.
- **One-time PINs.** A PIN expires after 10 minutes. Three wrong guesses end the pairing.
- **No trace.** MESHdrop keeps no transfer history and writes no logs. If a transfer fails or is cancelled, the partial file is deleted. 

**What relays can see.** By default MESHdrop uses Tailscale's public DERP relays. The contents are encrypted, but a relay can see which IP addresses connected, when, and roughly how much data was sent.

**Keep the link private.** Anyone with the link and the PIN can connect while the pairing is open. Share them only with the person you're sending to.
