import {Clipboard, Events} from "@wailsio/runtime";
import {SendService} from "../bindings/github.com/DWoodhouse22/meshdrop";

type State = "idle" | "waiting" | "connected";

const el = <T extends HTMLElement>(id: string) => document.getElementById(id)! as T;

const states: Record<State, HTMLElement> = {
    idle: el("state-idle"),
    waiting: el("state-waiting"),
    connected: el("state-connected"),
};
const addressEl = el("address");
const pinEl = el("pin");
const peerNameEl = el("peer-name");
const errorEl = el("error");
const sendBtn = el<HTMLButtonElement>("send");
const copyBtn = el<HTMLButtonElement>("copy");

let address = "";

function show(state: State) {
    for (const [name, section] of Object.entries(states)) {
        section.hidden = name !== state;
    }
}

function showError(err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errorEl.textContent = msg;
    console.error(err);
}

function clearError() {
    errorEl.textContent = "";
}

async function stop() {
    try {
        await SendService.StopSend();
    } catch (err) {
        showError(err);
    }
    address = "";
    show("idle");
}

sendBtn.addEventListener("click", async () => {
    clearError();
    sendBtn.disabled = true;
    sendBtn.textContent = "Starting…"; // Start can take a few seconds
    try {
        const info = await SendService.StartSend();
        address = info.address;
        addressEl.textContent = info.address;
        pinEl.textContent = info.pin;
        show("waiting");
    } catch (err) {
        showError(err);
    } finally {
        sendBtn.disabled = false;
        sendBtn.textContent = "Send";
    }
});

copyBtn.addEventListener("click", async () => {
    try {
        await Clipboard.SetText(address);
        copyBtn.textContent = "Copied";
        setTimeout(() => (copyBtn.textContent = "Copy link"), 1500);
    } catch (err) {
        showError(err);
    }
});

el("cancel-waiting").addEventListener("click", stop);
el("cancel-connected").addEventListener("click", stop);

Events.On("send:connected", (ev) => {
    clearError();
    peerNameEl.textContent = ev.data || "unnamed device";
    show("connected");
});

// A finished session can't be reused, so stop the server and go back to idle.
Events.On("send:disconnected", async (ev) => {
    if (ev.data) {
        errorEl.textContent = `Disconnected: ${ev.data}`;
    }
    await stop();
});

show("idle");
