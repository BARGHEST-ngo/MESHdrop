import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-sans/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "./style.css";

import {Clipboard, Events} from "@wailsio/runtime";
import {ReceiveService, SendService} from "../bindings/github.com/DWoodhouse22/meshdrop";

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;

// ============================================================
// Frame: screens, header word, footer, message line
// ============================================================

const screens = {
    "home": el("screen-home"),
    "send-waiting": el("screen-send-waiting"),
    "send-connected": el("screen-send-connected"),
    "send-sending": el("screen-send-sending"),
    "send-sent": el("screen-send-sent"),
    "send-declined": el("screen-send-declined"),
    "receive-form": el("screen-receive-form"),
    "receive-connecting": el("screen-receive-connecting"),
    "receive-connected": el("screen-receive-connected"),
    "receive-offer": el("screen-receive-offer"),
    "receive-receiving": el("screen-receive-receiving"),
    "receive-saved": el("screen-receive-saved"),
    "failed": el("screen-failed"),
};
type Screen = keyof typeof screens;
let current: Screen = "home";

const contextEl = el("context");
const footDot = el("foot-dot");
const footText = el("foot-text");
const messageEl = el("message");

// Shows one screen and takes the header word and footer line from its
// data-* attributes. Clears any message from the previous screen.
function show(screen: Screen) {
    current = screen;
    for (const [name, section] of Object.entries(screens)) {
        section.hidden = name !== screen;
    }
    const s = screens[screen];
    contextEl.textContent = s.dataset.context ?? "";
    footText.textContent = s.dataset.footer ?? "";
    footDot.hidden = !("dot" in s.dataset);
    clearMessage();
}

function showError(err: unknown) {
    messageEl.className = "message is-error";
    messageEl.textContent = err instanceof Error ? err.message : String(err);
    console.error(err);
}

function showNotice(msg: string) {
    messageEl.className = "message is-info";
    messageEl.textContent = msg;
}

function clearMessage() {
    messageEl.className = "message";
    messageEl.textContent = "";
}

// ============================================================
// Helpers
// ============================================================

type FileMeta = { name: string; size: number };

function formatSize(bytes: number): string {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    while (bytes >= 1024 && i < units.length - 1) {
        bytes /= 1024;
        i++;
    }
    return `${i === 0 ? bytes : bytes.toFixed(1)} ${units[i]}`;
}

// "name · size". textContent only, so odd file names (including ones chosen
// by a remote sender) can't inject HTML.
function renderFile(target: HTMLElement, f: FileMeta) {
    const name = document.createElement("strong");
    name.textContent = f.name;
    target.replaceChildren(name, ` · ${formatSize(f.size)}`);
}

function dirOf(path: string): string {
    const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    return i > 0 ? path.slice(0, i) : path;
}

// ---- Progress cards ----
// Indeterminate (sliding bar, no numbers) until the first progress event.

type Progress = { done: number; total: number } | null;

function resetProgress(card: HTMLElement) {
    card.classList.add("is-indeterminate");
    card.querySelector<HTMLElement>(".fill")!.style.width = "";
}

function setProgress(card: HTMLElement, done: number, total: number) {
    const pct = total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : 100;
    card.classList.remove("is-indeterminate");
    card.querySelector<HTMLElement>(".pct")!.textContent = `${pct}%`;
    card.querySelector<HTMLElement>(".fill")!.style.width = `${pct}%`;
    card.querySelector<HTMLElement>(".bytes")!.textContent = `${formatSize(done)} of ${formatSize(total)}`;
}

// ---- Failed screen (shared by both sides) ----

function showFailed(opts: {
    side: "send" | "receive";
    file: FileMeta | null;
    peer?: string;
    detail: string;
    progress: Progress;
}) {
    const {side, file, peer, detail, progress} = opts;
    show("failed");
    contextEl.textContent = side === "send" ? "Sending" : "Receiving";

    const at = progress ? ` at ${Math.floor((progress.done / Math.max(progress.total, 1)) * 100)}%` : "";
    if (side === "receive") {
        el("failed-line").textContent = `The connection to the sender was lost${at}. The partial file has been deleted.`;
        el("failed-hint").textContent = "To try again, ask the sender for a new link and PIN.";
        el("failed-retry").textContent = "Enter a new link";
    } else {
        el("failed-line").textContent = `The transfer to ${peer || "the receiver"} stopped${at}.`;
        el("failed-hint").textContent = "To try again, start a new send. You'll get a new link and PIN.";
        el("failed-retry").textContent = "Try again";
    }
    failedRetry = side === "receive" ? openReceiveForm : () => startSend(el<HTMLButtonElement>("failed-retry"));

    el("failed-fact-name").textContent = file?.name ?? "—";

    const showProgress = progress !== null;
    el("failed-fact-progress-label").textContent = side === "receive" ? "Received" : "Sent";
    el("failed-fact-progress-label").hidden = !showProgress;
    el("failed-fact-progress").hidden = !showProgress;
    if (progress) {
        el("failed-fact-progress").textContent = `${formatSize(progress.done)} of ${formatSize(progress.total)}`;
    }

    // Only the receiver writes to disk; its .part file is deleted on failure.
    el("failed-fact-disk-label").hidden = side !== "receive";
    el("failed-fact-disk").hidden = side !== "receive";

    el("failed-detail").textContent = detail || "connection lost";
}

let failedRetry: () => void = () => show("home");
el("failed-retry").addEventListener("click", () => failedRetry());
el("failed-done").addEventListener("click", () => show("home"));

// ============================================================
// Send
// ============================================================

const copyBtn = el<HTMLButtonElement>("copy");
const sendProgress = el("send-progress");

let sendFile: FileMeta | null = null;
let sendAddress = "";
let peerName = "";
let sendProgressNow: Progress = null;

// True while a send session is ours to show. Cleared before stopping, so the
// disconnect event that our own Stop causes is ignored.
let sendActive = false;

async function stopSend() {
    sendActive = false;
    sendAddress = "";
    try {
        await SendService.StopSend();
    } catch (err) {
        console.error(err);
    }
}

// Picks a file and opens a pairing. `button` is whichever button started it
// (Home, "Send another file", "Try again"), so it can show progress.
async function startSend(button: HTMLButtonElement) {
    clearMessage();
    const label = button.textContent;
    button.disabled = true;
    try {
        const file = await SendService.ChooseFile();
        if (!file.name) {
            return; // picker cancelled: stay where we are
        }
        sendFile = {name: file.name, size: file.size};

        button.textContent = "Starting…"; // Start can take a few seconds
        const info = await SendService.StartSend();
        sendAddress = info.address;
        peerName = "";
        sendProgressNow = null;

        renderFile(el("send-file"), sendFile);
        el("pin").textContent = `${info.pin.slice(0, 3)} ${info.pin.slice(3)}`;
        el("address").textContent = info.address;
        copyBtn.textContent = "Copy link";
        sendActive = true;
        show("send-waiting");
    } catch (err) {
        showError(err);
        // A file may already be chosen; clear it so the next send starts fresh.
        await SendService.StopSend().catch(() => {});
    } finally {
        button.disabled = false;
        button.textContent = label;
    }
}

el("send").addEventListener("click", (e) => startSend(e.currentTarget as HTMLButtonElement));
el("sent-again").addEventListener("click", (e) => startSend(e.currentTarget as HTMLButtonElement));
el("declined-again").addEventListener("click", (e) => startSend(e.currentTarget as HTMLButtonElement));
el("sent-done").addEventListener("click", () => show("home"));
el("declined-done").addEventListener("click", () => show("home"));

copyBtn.addEventListener("click", async () => {
    try {
        await Clipboard.SetText(sendAddress);
        copyBtn.textContent = "Copied";
        setTimeout(() => (copyBtn.textContent = "Copy link"), 1500);
    } catch (err) {
        showError(err);
    }
});

async function cancelSend() {
    await stopSend();
    show("home");
}
el("send-cancel").addEventListener("click", cancelSend);
el("send-disconnect").addEventListener("click", cancelSend);
el("sending-cancel").addEventListener("click", cancelSend);

Events.On("send:connected", (ev) => {
    if (!sendActive) return;
    peerName = ev.data || "unnamed device";
    el("peer-name").textContent = peerName;
    if (sendFile) renderFile(el("connected-file"), sendFile);
    show("send-connected");
});

Events.On("send:accepted", () => {
    if (!sendActive) return;
    el("sending-name").textContent = sendFile?.name ?? "";
    el("sending-peer").textContent = peerName;
    resetProgress(sendProgress);
    show("send-sending");
});

// Bytes sent so far, about 10 times a second.
Events.On("send:progress", (ev) => {
    if (!sendActive || !sendFile) return;
    sendProgressNow = {done: ev.data, total: sendFile.size};
    setProgress(sendProgress, ev.data, sendFile.size);
});

// The receiver confirmed it has every byte, so it's safe to stop now.
Events.On("send:complete", async () => {
    if (!sendActive) return;
    await stopSend();
    el("sent-name").textContent = sendFile?.name ?? "";
    el("sent-peer").textContent = peerName;
    el("sent-fact-name").textContent = sendFile?.name ?? "";
    el("sent-fact-size").textContent = sendFile ? formatSize(sendFile.size) : "";
    el("sent-fact-peer").textContent = peerName;
    show("send-sent");
});

Events.On("send:declined", async () => {
    if (!sendActive) return;
    await stopSend();
    el("declined-peer").textContent = peerName;
    el("declined-name").textContent = sendFile?.name ?? "";
    show("send-declined");
});

Events.On("send:failed", async (ev) => {
    if (!sendActive) return;
    await stopSend();
    showFailed({side: "send", file: sendFile, peer: peerName, detail: ev.data, progress: sendProgressNow});
});

// A finished session can't be reused, so stop the server either way.
Events.On("send:disconnected", async (ev) => {
    if (!sendActive) return;
    const wasSending = current === "send-sending";
    await stopSend();
    if (wasSending) {
        showFailed({side: "send", file: sendFile, peer: peerName, detail: ev.data, progress: sendProgressNow});
    } else {
        show("home");
        showError(ev.data ? `Disconnected: ${ev.data}` : "The receiver disconnected.");
    }
});

// ============================================================
// Receive
// ============================================================

const receiveForm = el<HTMLFormElement>("receive-form");
const receiveAddress = el<HTMLTextAreaElement>("receive-address");
const receivePin = el<HTMLInputElement>("receive-pin");
const receiveConnect = el<HTMLButtonElement>("receive-connect");
const acceptBtn = el<HTMLButtonElement>("offer-accept");
const declineBtn = el<HTMLButtonElement>("offer-decline");
const receiveProgress = el("receive-progress");

// Bumped on every Connect and Cancel, so a Connect that finishes after the
// user cancelled (or started again) is ignored instead of changing the screen.
let attempt = 0;

// Same idea as sendActive: ignore the disconnect our own Cancel causes.
let receiveActive = false;

// The offer can arrive before Connect() has returned, so remember it and
// don't let the Connect success overwrite the offer screen.
let offerShown = false;
let offer: FileMeta | null = null;
let savePath = "";
let receiveProgressNow: Progress = null;

// STOPGAP: MESHnet v0.1.0-alpha doesn't tell the other side about a deliberate
// close, and Disconnect drops queued messages. So we can't disconnect straight
// after our last Send (the message would be lost). Give it a moment to go out,
// then hang up. Remove once MESHnet closes gracefully.
const FLUSH_MS = 500;

async function hangUp() {
    attempt++;
    receiveActive = false;
    try {
        await ReceiveService.CancelReceive();
    } catch (err) {
        console.error(err);
    }
}

function hangUpAfterFlush() {
    receiveActive = false; // our own hang-up isn't an error
    setTimeout(hangUp, FLUSH_MS);
}

function updateConnectEnabled() {
    receiveConnect.disabled = receiveAddress.value.trim() === "" || receivePin.value.length !== 6;
}

function openReceiveForm() {
    receiveAddress.value = "";
    receivePin.value = "";
    updateConnectEnabled();
    show("receive-form");
    receiveAddress.focus();
}

el("receive").addEventListener("click", openReceiveForm);
el("receive-back").addEventListener("click", () => show("home"));

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
    const mine = ++attempt;
    receiveActive = true;
    offerShown = false;
    offer = null;
    savePath = "";
    receiveProgressNow = null;
    show("receive-connecting");
    try {
        await ReceiveService.Connect(receiveAddress.value.trim(), receivePin.value);
        if (mine === attempt && !offerShown) {
            el("receive-status").textContent = "Waiting for the sender…";
            show("receive-connected");
        }
    } catch (err) {
        if (mine === attempt) {
            receiveActive = false;
            show("receive-form"); // keeps what they typed, so a typo is easy to fix
            showError(err);
        }
    }
});

async function cancelReceive() {
    await hangUp();
    show("home");
}
el("receive-cancel").addEventListener("click", cancelReceive);
el("receive-disconnect").addEventListener("click", cancelReceive);
el("receiving-cancel").addEventListener("click", cancelReceive);

Events.On("receive:offer", (ev) => {
    if (!receiveActive) return;
    offerShown = true;
    offer = {name: ev.data.name, size: ev.data.size};
    el("offer-name").textContent = offer.name;
    el("offer-size").textContent = formatSize(offer.size);
    acceptBtn.disabled = declineBtn.disabled = false;
    show("receive-offer");
});

acceptBtn.addEventListener("click", async () => {
    acceptBtn.disabled = declineBtn.disabled = true;
    try {
        // Opens the save dialog; returns the chosen path, "" if cancelled.
        const path = await ReceiveService.Accept();
        if (path === "") {
            acceptBtn.disabled = declineBtn.disabled = false;
            return; // dialog cancelled: stay on the offer screen
        }
        savePath = path;

        if (offer) renderFile(el("receiving-file"), offer);
        el("receiving-dest").textContent = savePath;
        el("receiving-dest-block").hidden = savePath === "";
        resetProgress(receiveProgress);
        show("receive-receiving");
    } catch (err) {
        showError(err);
        acceptBtn.disabled = declineBtn.disabled = false;
    }
});

declineBtn.addEventListener("click", async () => {
    acceptBtn.disabled = declineBtn.disabled = true;
    try {
        await ReceiveService.Decline();
    } catch (err) {
        showError(err);
        acceptBtn.disabled = declineBtn.disabled = false;
        return;
    }
    hangUpAfterFlush();
    show("home");
    showNotice("You declined the file.");
});

// Bytes received so far, about 10 times a second.
Events.On("receive:progress", (ev) => {
    if (!receiveActive || !offer) return;
    receiveProgressNow = {done: ev.data, total: offer.size};
    setProgress(receiveProgress, ev.data, offer.size);
});

// Saved, and "received" already sent to the sender.
Events.On("receive:complete", () => {
    if (!receiveActive) return;
    hangUpAfterFlush();

    const name = document.createElement("strong");
    name.textContent = offer?.name ?? "The file";
    el("saved-line").replaceChildren(name, savePath ? ` was saved to ${dirOf(savePath)}.` : " has been saved.");
    el("saved-fact-name").textContent = offer?.name ?? "";
    el("saved-fact-size").textContent = offer ? formatSize(offer.size) : "";
    el("saved-fact-dest").textContent = savePath ? dirOf(savePath) : "";
    el("saved-fact-dest-label").hidden = savePath === "";
    el("saved-fact-dest").hidden = savePath === "";

    show("receive-saved");
});

el("saved-done").addEventListener("click", () => show("home"));

// The .part file has already been deleted on the Go side.
Events.On("receive:failed", async (ev) => {
    if (!receiveActive) return; // e.g. we cancelled mid-transfer ourselves
    await hangUp();
    showFailed({side: "receive", file: offer, detail: ev.data, progress: receiveProgressNow});
});

Events.On("receive:disconnected", async (ev) => {
    if (!receiveActive) return;
    const wasReceiving = current === "receive-receiving";
    await hangUp();
    if (wasReceiving) {
        showFailed({side: "receive", file: offer, detail: ev.data, progress: receiveProgressNow});
    } else {
        show("home");
        showError(ev.data ? `Disconnected: ${ev.data}` : "The sender disconnected.");
    }
});

show("home");
