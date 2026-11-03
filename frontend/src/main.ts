import {Clipboard, Events} from "@wailsio/runtime";
import {ReceiveService, SendService} from "../bindings/github.com/DWoodhouse22/meshdrop";

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;

// ---- Screens ----

const screens = {
    "home": el("screen-home"),
    "send-waiting": el("screen-send-waiting"),
    "send-connected": el("screen-send-connected"),
    "receive-form": el("screen-receive-form"),
    "receive-connecting": el("screen-receive-connecting"),
    "receive-connected": el("screen-receive-connected"),
    "receive-offer": el("screen-receive-offer"),
};
type Screen = keyof typeof screens;

function show(screen: Screen) {
    for (const [name, section] of Object.entries(screens)) {
        section.hidden = name !== screen;
    }
}

// ---- Status line (errors in red, notices in grey) ----

const errorEl = el("error");

function showError(err: unknown) {
    errorEl.classList.remove("is-info");
    errorEl.textContent = err instanceof Error ? err.message : String(err);
    console.error(err);
}

function showNotice(msg: string) {
    errorEl.classList.add("is-info");
    errorEl.textContent = msg;
}

function clearError() {
    errorEl.classList.remove("is-info");
    errorEl.textContent = "";
}

// ---- Files ----

function formatSize(bytes: number): string {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    while (bytes >= 1024 && i < units.length - 1) {
        bytes /= 1024;
        i++;
    }
    return `${i === 0 ? bytes : bytes.toFixed(1)} ${units[i]}`;
}

// Renders "name · size" into target. textContent only, so odd file names
// (including ones chosen by a remote sender) can't inject HTML.
function renderFile(target: HTMLElement, name: string, size: number) {
    target.replaceChildren();
    const nameEl = document.createElement("strong");
    nameEl.textContent = name;
    const sizeEl = document.createElement("span");
    sizeEl.className = "file-size";
    sizeEl.textContent = ` · ${formatSize(size)}`;
    target.append(nameEl, sizeEl);
}

// ---- Send ----

const sendBtn = el<HTMLButtonElement>("send");
const copyBtn = el<HTMLButtonElement>("copy");
const sendStatus = el("send-status");
let sendAddress = "";
let peerName = "";

// True while a send session is ours to show. Cleared before stopping, so the
// disconnect event that our own Stop causes is ignored.
let sendActive = false;

async function stopSend() {
    sendActive = false;
    try {
        await SendService.StopSend();
    } catch (err) {
        showError(err);
    }
    sendAddress = "";
    show("home");
}

sendBtn.addEventListener("click", async () => {
    clearError();
    sendBtn.disabled = true;
    try {
        const file = await SendService.ChooseFile();
        if (!file.name) {
            return; // picker cancelled: stay on home
        }
        renderFile(el("send-file"), file.name, file.size);

        sendBtn.textContent = "Starting…"; // Start can take a few seconds
        const info = await SendService.StartSend();
        sendAddress = info.address;
        el("address").textContent = info.address;
        el("pin").textContent = info.pin;
        sendActive = true;
        show("send-waiting");
    } catch (err) {
        showError(err);
        // A file may already be chosen; clear it so the next Send starts fresh.
        await SendService.StopSend().catch(() => {});
    } finally {
        sendBtn.disabled = false;
        sendBtn.textContent = "Send";
    }
});

copyBtn.addEventListener("click", async () => {
    try {
        await Clipboard.SetText(sendAddress);
        copyBtn.textContent = "Copied";
        setTimeout(() => (copyBtn.textContent = "Copy link"), 1500);
    } catch (err) {
        showError(err);
    }
});

el("send-cancel").addEventListener("click", stopSend);
el("send-disconnect").addEventListener("click", stopSend);

Events.On("send:connected", (ev) => {
    if (!sendActive) return;
    clearError();
    peerName = ev.data || "unnamed device";
    el("peer-name").textContent = peerName;
    sendStatus.textContent = "Waiting for them to accept…";
    show("send-connected");
});

Events.On("send:accepted", () => {
    if (!sendActive) return;
    sendStatus.textContent = "Accepted"; // the transfer itself comes next
});

Events.On("send:declined", async () => {
    if (!sendActive) return;
    await stopSend();
    showNotice(`${peerName} declined the file.`);
});

// A finished session can't be reused, so stop the server and go home.
Events.On("send:disconnected", async (ev) => {
    if (!sendActive) return;
    await stopSend();
    if (ev.data) {
        showError(`Disconnected: ${ev.data}`);
    }
});

// ---- Receive ----

const receiveForm = el<HTMLFormElement>("screen-receive-form");
const receiveAddress = el<HTMLTextAreaElement>("receive-address");
const receivePin = el<HTMLInputElement>("receive-pin");
const receiveConnect = el<HTMLButtonElement>("receive-connect");
const receiveStatus = el("receive-status");
const acceptBtn = el<HTMLButtonElement>("offer-accept");
const declineBtn = el<HTMLButtonElement>("offer-decline");

// Bumped on every Connect and Cancel, so a Connect that finishes after the
// user cancelled (or started again) is ignored instead of changing the screen.
let attempt = 0;

// Same idea as sendActive: ignore the disconnect our own Cancel causes.
let receiveActive = false;

// The offer can arrive before Connect() has returned, so remember it and
// don't let the Connect success overwrite the offer screen.
let offerShown = false;

function updateConnectEnabled() {
    receiveConnect.disabled = receiveAddress.value.trim() === "" || receivePin.value.length !== 6;
}

async function stopReceive() {
    attempt++;
    receiveActive = false;
    try {
        await ReceiveService.CancelReceive();
    } catch (err) {
        showError(err);
    }
    show("home");
}

el("receive").addEventListener("click", () => {
    clearError();
    receiveAddress.value = "";
    receivePin.value = "";
    updateConnectEnabled();
    show("receive-form");
    receiveAddress.focus();
});

receiveAddress.addEventListener("input", updateConnectEnabled);
receivePin.addEventListener("input", () => {
    receivePin.value = receivePin.value.replace(/\D/g, "").slice(0, 6); // digits only
    updateConnectEnabled();
});

receiveForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (receiveConnect.disabled) {
        return;
    }
    clearError();
    const mine = ++attempt;
    receiveActive = true;
    offerShown = false;
    show("receive-connecting");
    try {
        await ReceiveService.Connect(receiveAddress.value.trim(), receivePin.value);
        if (mine === attempt && !offerShown) {
            receiveStatus.textContent = "Waiting for the sender…";
            show("receive-connected");
        }
    } catch (err) {
        if (mine === attempt) {
            receiveActive = false;
            showError(err);
            show("receive-form");
        }
    }
});

el("receive-back").addEventListener("click", () => {
    clearError();
    show("home");
});
el("receive-cancel").addEventListener("click", stopReceive);
el("receive-disconnect").addEventListener("click", stopReceive);

Events.On("receive:offer", (ev) => {
    if (!receiveActive) return;
    offerShown = true;
    renderFile(el("offer-file"), ev.data.name, ev.data.size);
    acceptBtn.disabled = false;
    declineBtn.disabled = false;
    show("receive-offer");
});

acceptBtn.addEventListener("click", async () => {
    acceptBtn.disabled = declineBtn.disabled = true;
    try {
        await ReceiveService.Accept();
        receiveStatus.textContent = "Accepted. Waiting for the file…";
        show("receive-connected");
    } catch (err) {
        showError(err);
        acceptBtn.disabled = declineBtn.disabled = false;
    }
});

// STOPGAP: MESHnet v0.1.0-alpha doesn't tell the other side about a deliberate
// close, and Disconnect drops queued messages. So we can't wait for the sender
// to hang up (we'd only notice at the liveness timeout), and we can't disconnect
// straight after Send (the decline would be lost). Give the message a moment to
// go out, then hang up ourselves. Remove once MESHnet closes gracefully.
const DECLINE_FLUSH_MS = 500;

declineBtn.addEventListener("click", async () => {
    acceptBtn.disabled = declineBtn.disabled = true;
    try {
        await ReceiveService.Decline();
    } catch (err) {
        showError(err);
        acceptBtn.disabled = declineBtn.disabled = false;
        return;
    }
    receiveActive = false; // our own hang-up below isn't an error
    receiveStatus.textContent = "Declined. Closing…";
    show("receive-connected");
    await new Promise((r) => setTimeout(r, DECLINE_FLUSH_MS));
    await stopReceive();
    showNotice("You declined the file.");
});

Events.On("receive:disconnected", async (ev) => {
    if (!receiveActive) return;
    await stopReceive();
    if (ev.data) {
        showError(`Disconnected: ${ev.data}`);
    }
});

show("home");
