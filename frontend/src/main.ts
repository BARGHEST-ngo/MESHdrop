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
};
type Screen = keyof typeof screens;

function show(screen: Screen) {
    for (const [name, section] of Object.entries(screens)) {
        section.hidden = name !== screen;
    }
}

// ---- Errors ----

const errorEl = el("error");

function showError(err: unknown) {
    errorEl.textContent = err instanceof Error ? err.message : String(err);
    console.error(err);
}

function clearError() {
    errorEl.textContent = "";
}

// ---- Send ----

const sendBtn = el<HTMLButtonElement>("send");
const copyBtn = el<HTMLButtonElement>("copy");
let sendAddress = "";

async function stopSend() {
    try {
        await SendService.StopSend();
    } catch (err) {
        showError(err);
    }
    sendAddress = "";
    show("home");
}

function formatSize(bytes: number): string {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    while (bytes >= 1024 && i < units.length - 1) {
        bytes /= 1024;
        i++;
    }
    return `${i === 0 ? bytes : bytes.toFixed(1)} ${units[i]}`;
}

function showFile(name: string, size: number) {
    const fileEl = el("send-file");
    fileEl.replaceChildren(); // textContent only, so odd file names can't inject HTML
    const nameEl = document.createElement("strong");
    nameEl.textContent = name;
    const sizeEl = document.createElement("span");
    sizeEl.className = "file-size";
    sizeEl.textContent = ` · ${formatSize(size)}`;
    fileEl.append(nameEl, sizeEl);
}

sendBtn.addEventListener("click", async () => {
    clearError();
    sendBtn.disabled = true;
    try {
        const file = await SendService.ChooseFile();
        if (!file.name) {
            return; // picker cancelled: stay on home
        }
        showFile(file.name, file.size);

        sendBtn.textContent = "Starting…"; // Start can take a few seconds
        const info = await SendService.StartSend();
        sendAddress = info.address;
        el("address").textContent = info.address;
        el("pin").textContent = info.pin;
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
    clearError();
    el("peer-name").textContent = ev.data || "unnamed device";
    show("send-connected");
});

// A finished session can't be reused, so stop the server and go home.
Events.On("send:disconnected", async (ev) => {
    if (ev.data) {
        errorEl.textContent = `Disconnected: ${ev.data}`;
    }
    await stopSend();
});

// ---- Receive ----

const receiveForm = el<HTMLFormElement>("screen-receive-form");
const receiveAddress = el<HTMLTextAreaElement>("receive-address");
const receivePin = el<HTMLInputElement>("receive-pin");
const receiveConnect = el<HTMLButtonElement>("receive-connect");

// Bumped on every Connect and Cancel, so a Connect that finishes after the
// user cancelled (or started again) is ignored instead of changing the screen.
let attempt = 0;

function updateConnectEnabled() {
    receiveConnect.disabled = receiveAddress.value.trim() === "" || receivePin.value.length !== 6;
}

async function stopReceive() {
    attempt++;
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
    show("receive-connecting");
    try {
        await ReceiveService.Connect(receiveAddress.value.trim(), receivePin.value);
        if (mine === attempt) {
            show("receive-connected");
        }
    } catch (err) {
        if (mine === attempt) {
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

Events.On("receive:disconnected", async (ev) => {
    if (ev.data) {
        errorEl.textContent = `Disconnected: ${ev.data}`;
    }
    await stopReceive();
});

show("home");
