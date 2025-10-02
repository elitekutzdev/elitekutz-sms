// --- deps & setup ---
import express from "express";
import morgan from "morgan";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const app = express();

// Accept JSON even when Infobip sends charset or vendor types
app.use(express.json({ type: ["application/json", "application/*+json"] }));
app.use(morgan("dev")); // concise request logs

// --- ENV ---
const BASE_URL = process.env.INFOBIP_BASE_URL;   // e.g. https://xxxx.api.infobip.com
const API_KEY  = process.env.INFOBIP_API_KEY;    // MUST start with "App "
const SENDER   = process.env.INFOBIP_SENDER;     // e.g. +18333586148
const PORT     = process.env.PORT || 3000;

// sanity checks (prints once at boot so mistakes are obvious)
(function validateEnv() {
  if (!BASE_URL)  console.warn("[ENV] INFOBIP_BASE_URL is missing");
  if (!API_KEY)   console.warn("[ENV] INFOBIP_API_KEY is missing");
  if (API_KEY && !/^App\s+/i.test(API_KEY)) {
    console.warn('[ENV] INFOBIP_API_KEY should start with "App " (e.g., App xxxxx)');
  }
  if (!SENDER)    console.warn("[ENV] INFOBIP_SENDER is missing");
})();

// --- util: send SMS via Infobip (strong logging) ---
async function sendSms({ to, text }) {
  try {
    console.log("-> sending SMS", { to, from: SENDER, preview: text.slice(0, 80) });

    const res = await fetch(`${BASE_URL}/sms/2/text/advanced`, {
      method: "POST",
      headers: {
        Authorization: API_KEY, // must include "App "
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        messages: [{ destinations: [{ to }], from: SENDER, text }],
      }),
    });

    const bodyText = await res.text();
    if (!res.ok) {
      console.error(`<- Infobip ERROR ${res.status}: ${bodyText}`);
      throw new Error(`Infobip ${res.status}`);
    }

    console.log("<- Infobip OK", bodyText);
    try { return JSON.parse(bodyText); } catch { return bodyText; }
  } catch (err) {
    console.error("sendSms() failed:", err);
    throw err;
  }
}

// --- health check ---
app.get("/health", (_req, res) => res.json({ ok: true }));

// --- keywords for compliance ---
const STOP_WORDS  = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'];
const START_WORDS = ['START', 'UNSTOP', 'YES'];

// --- Inbound SMS webhook (Infobip -> you) ---
app.post("/webhooks/infobip/inbound-sms", async (req, res) => {
  try {
    // Handle common Infobip MO payload shapes
    const msg =
      req.body?.results?.[0] ||
      req.body?.messages?.[0] ||
      req.body?.inboundMessage ||
      req.body;

    const from =
      msg?.from ||
      msg?.sender?.phoneNumber ||
      msg?.sender ||
      msg?.msisdn ||
      msg?.message?.from;

    const raw =
      (msg?.cleanText ??
       msg?.text ??
       msg?.message?.text ??
       "").toString();

    const norm = raw.trim().toUpperCase().replace(/\s+/g, " ");

    if (STOP_WORDS.includes(norm)) {
      console.log(`STOP received from ${from}; honoring opt-out (no reply).`);
      return res.status(200).json({ ok: true });
    }

    if (START_WORDS.includes(norm)) {
      console.log(`START received from ${from}; sending re-opt confirmation.`);
      await sendSms({
        to: from,
        text: "You are opted in. Reply HELP for info or STOP to opt out anytime."
      });
      return res.json({ ok: true });
    }

    if (norm === "HELP") {
      console.log(`HELP detected from ${from}`);
      await sendSms({
        to: from,
        text:
          "Elite Kutz: For help with SMS visit updates, call (972) 673-0114 or email support@elitekutzkiosk.com. Reply STOP to opt out, START to rejoin."
      });
      return res.json({ ok: true });
    }

    // Default friendly auto-reply (optional)
    await sendSms({
      to: from,
      text: "Thanks! Reply HELP for info or STOP to opt out."
    });
    return res.json({ ok: true });
  } catch (err) {
    console.error("Inbound handler error:", err);
    // Still ack so Infobip doesn’t retry forever
    return res.status(200).json({ ok: true });
  }
});

// --- Kiosk-triggered endpoints (you -> Infobip) ---
app.post("/api/send-ready", async (req, res) => {
  try {
    const { to, barber } = req.body || {};
    if (!to || !barber) return res.status(400).json({ ok: false, error: "Missing to/barber" });
    const result = await sendSms({
      to,
      text: `Elite Kutz: Your chair is ready with ${barber}. Reply STOP to cancel, HELP for help, START to re-opt in.`
    });
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/send-assignment", async (req, res) => {
  try {
    const { to, client, barber, position } = req.body || {};
    if (!to || !client || !barber) return res.status(400).json({ ok: false, error: "Missing to/client/barber" });
    const p = Number.isFinite(Number(position)) ? `You're #${Number(position)} in line. ` : "";
    const result = await sendSms({
      to,
      text: `Elite Kutz: ${client}, you're assigned to ${barber}. ${p}Reply STOP to cancel, HELP for help, START to re-opt in.`
    });
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- simple test endpoint to verify outbound without kiosk ---
app.post("/api/test-send", async (req, res) => {
  try {
    const { to, text = "Elite Kutz test message." } = req.body || {};
    if (!to) return res.status(400).json({ ok: false, error: "Missing to" });
    const result = await sendSms({ to, text });
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => console.log(`Webhook listening on :${PORT}`));
