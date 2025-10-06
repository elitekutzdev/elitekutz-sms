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
// --- CORS (allow the kiosk site only) ---
const ALLOW_ORIGIN = "https://elitekutzkiosk.com";

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin === ALLOW_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  // if you want to allow local dev too, uncomment this:
  // if (origin === "http://localhost:5500") res.setHeader("Access-Control-Allow-Origin", origin);

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "600"); // cache preflight 10 min
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// --- ENV ---
const BASE_URL = process.env.INFOBIP_BASE_URL;
const API_KEY  = process.env.INFOBIP_API_KEY;
const SENDER   = process.env.INFOBIP_SENDER;
const PORT     = process.env.PORT || 3000;

/* ===== REPLACEMENT STARTS HERE ===== */
// Normalize US numbers to +E.164 so lookups always match
function normalizeUS(phone) {
  if (!phone) return "";
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  if (digits.length === 10) return "+1" + digits;
  return "+" + digits; // fallback
}

// Parse raw env list and then normalize the keys
// Example BARBER_NUMBERS env: +12149919940:Mike,+12146296917:Red
const RAW_BARBER_NUMBERS = (process.env.BARBER_NUMBERS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean)
  .reduce((acc, pair) => {
    const [phone, name] = pair.split(":").map(x => (x || "").trim());
    if (phone && name) acc[phone] = name;
    return acc;
  }, {});

const BARBER_NUMBERS = Object.fromEntries(
  Object.entries(RAW_BARBER_NUMBERS).map(([k, v]) => [normalizeUS(k), v])
);
/* ===== REPLACEMENT ENDS HERE ===== */

// sanity checks (prints once at boot so mistakes are obvious)
(function validateEnv() {
  if (!BASE_URL)  console.warn("[ENV] INFOBIP_BASE_URL is missing");
  if (!API_KEY)   console.warn("[ENV] INFOBIP_API_KEY is missing");
  if (API_KEY && !/^App\s+/i.test(API_KEY)) {
    console.warn('[ENV] INFOBIP_API_KEY should start with "App " (e.g., App xxxxx)');
  }
  if (!SENDER)    console.warn("[ENV] INFOBIP_SENDER is missing");
  if (!process.env.BARBER_NUMBERS)
    console.warn("[ENV] BARBER_NUMBERS is missing (no barber SMS control)");
})();

// ======= TEMPLATES (new keys) =======
const TEMPLATES = {
  // ---------- SPECIFIC_BARBER_REQUEST ----------
  SBR_CLIENT_SINGLE: ({ clientName, barberName }) =>
    `${clientName}, you have requested ${barberName}.`,
  SBR_CLIENT_MULTI: ({ clientName, barberNamesCsv }) =>
    `${clientName}, you have requested ${barberNamesCsv}!`,
  SBR_BARBER_COMPACT: ({ clientName, barberName, membersNote, declined }) =>
    `${clientName} has requested ${barberName}${membersNote}${declined ? " — PHOTOS/VIDEOS DECLINED" : ""}.`,

  // ---------- CLIENT_REMOVED_FROM_KIOSK ----------
  CRK_CLIENT: ({ clientName }) =>
    `${clientName}, you have been removed from the waitlist. Feel free to sign in again when you're ready!`,

  // ---------- CLIENT_ASSIGNED ----------
  CA_CLIENT_SINGLE: ({ clientName, barberName }) =>
    `${clientName}, you are assigned to ${barberName}.`,
  CA_CLIENT_MULTI: ({ clientName, barberNamesCsv }) =>
    `${clientName}, you have been assigned to ${barberNamesCsv}!`,
  CA_BARBER_COMPACT: ({ clientName, barberName, membersNote, declined }) =>
    `${clientName} has been assigned to ${barberName}${membersNote}${declined ? " — PHOTOS/VIDEOS DECLINED" : ""}.`,

  // ---------- CLIENT_PLACED_ON_WAITLIST ----------
  CPW_CLIENT_SINGLE: ({ clientName, indexLabel }) =>
    `${clientName} you have been placed on the waitlist. You're #${indexLabel} in line!`,
  CPW_CLIENT_MULTI: ({ clientName, barberNamesCsv }) =>
    `${clientName}, you have been placed on the waitlist. ${barberNamesCsv}!`,
  CPW_BARBER_COMPACT: ({ clientName, membersNote, declined }) =>
    `${clientName} has been placed on the waitlist${membersNote}${declined ? " — PHOTOS/VIDEOS DECLINED" : ""}.`,

  // ---------- CLIENT_RE-WAITLISTED ----------
  CRW_CLIENT_SINGLE: ({ clientName }) =>
    `${clientName}, you have been re-waitlisted.`,
  CRW_CLIENT_MULTI: ({ clientName, barberNamesCsv }) =>
    `${clientName}, you have been re-waitlisted ${barberNamesCsv}!`,
CRW_BARBER_COMPACT: ({ clientName, indexLabel, membersNote, declined }) =>
  `${clientName}${indexLabel ? ` ${indexLabel}` : ""} has been re-waitlisted${membersNote}${declined ? " — PHOTOS/VIDEOS DECLINED" : ""}.`
};

// ======= BARBER ROSTER (fill with real data) =======
// id: MUST match your kiosk's internal barberId exactly
// name: what appears in SMS (client-facing)
// phone: destination for that barber's texts
// status: "green" (available), "orange" (busy), "red" (unavailable)
//   - Used by getBusyBarbers() / getUnavailableBarbers()
//   - You can update this array at runtime if you wire status changes, but static is fine to start.
const ROSTER = [
  { id: "lyric",     name: "Lyric",     phone: "+16147695230", status: "green"  },
  { id: "taja",      name: "Taja",      phone: "+17133973128", status: "orange" },
  { id: "mike",      name: "Mike",      phone: "+12149919940", status: "red"    },
  { id: "devin",     name: "Devin",     phone: "+14694799891", status: "orange" },
  { id: "shelton",   name: "Shelton",   phone: "+16019187843", status: "red"    },
  { id: "hollywood", name: "Hollywood", phone: "+16822302957", status: "green"  },
  { id: "von",       name: "Von",       phone: "+15315419031", status: "red"    },
  { id: "martice",   name: "Martice",   phone: "+14699550317", status: "green"  },
  { id: "lou",       name: "Lou",       phone: "+13374416269", status: "red"    },
  { id: "uri",       name: "Uri",       phone: "+14696889121", status: "red"    },
  { id: "riley",     name: "Riley",     phone: "+14695257600", status: "red"    },
  { id: "nesha",     name: "Nesha",     phone: "+13186382982", status: "red"    },
  { id: "pete",      name: "Pete",      phone: "+12143088942", status: "red"    },
  { id: "red",       name: "Red",       phone: "+12146296917", status: "red"    },
];
// ======= BARBER LOOKUPS (keep/merge with yours) =======
const BARBERS_BY_ID = Object.fromEntries((ROSTER || []).map(b => [b.id, b]));

  typeof BARBERS_BY_ID === "object" && Object.keys(BARBERS_BY_ID).length
    ? BARBERS_BY_ID
    : Object.fromEntries((ROSTER || []).map(b => [b.id, b]));

// Busy/unavailable helpers (adjust to your statuses if needed)
function getUnavailableBarbers() {
  // treat RED as unavailable; change if your kiosk uses different codes
  return (ROSTER || []).filter(b => (b.status || "").toLowerCase() === "red");
}
function getBusyBarbers() {
  // treat NOT GREEN as busy (orange or red)
  return (ROSTER || []).filter(b => (b.status || "").toLowerCase() !== "green");
}

// ======= SHARED GROUPING/RENDER HELPERS =======
function groupAssignmentsByBarber(assignments = []) {
  // returns: { [barberId]: { indexes:[1,2], count:2, barberName, phone } }
  const out = {};
  for (const a of assignments) {
    const b = BARBERS_BY_ID[a.barberId];
    if (!b) throw new Error(`Unknown barberId: ${a.barberId}`);
    if (!out[a.barberId]) out[a.barberId] = { indexes: [], count: 0, barberName: b.name, phone: b.phone };
    out[a.barberId].indexes.push(a.memberIndex || 1);
    out[a.barberId].count++;
  }
  // sort member indexes numerically for a stable note like (members: 1, 3)
  for (const k of Object.keys(out)) out[k].indexes.sort((x,y)=>x-y);
  return out;
}

function csv(arr) { return (arr || []).join(", "); }

function buildMembersNote(count, indexesCsv) {
  return count > 1 ? ` (members: ${indexesCsv})` : "";
}

function buildDeclinedFlag(declinedPhotos) {
  return declinedPhotos ? true : false;
}

function computeClientSingleOrMultiText({ names, clientName, singleTpl, multiTpl }) {
  if (names.length <= 1) {
    return { text: singleTpl({ clientName, barberName: names[0] }), isMulti: false };
  }
  return { text: multiTpl({ clientName, barberNamesCsv: csv(names) }), isMulti: true };
}

// ======= PLANNERS =======

// event_name: SPECIFIC_BARBER_REQUEST
// when: immediately after client(s) placed on the waitlist
function planSpecificBarberRequest(payload) {
  const {
    clientName, clientPhone, partySize,
    assignments = [], declinedPhotos = false
  } = payload || {};
  if (!clientName || !clientPhone) throw new Error("SBR: missing clientName or clientPhone");
  if (!assignments.length) throw new Error("SBR: assignments[] required");

  const grouped = groupAssignmentsByBarber(assignments);
  const barberNames = Object.values(grouped).map(g => g.barberName);

  const out = [];

  // client (single vs multi)
  const clientMsg = computeClientSingleOrMultiText({
    names: barberNames,
    clientName,
    singleTpl: TEMPLATES.SBR_CLIENT_SINGLE,
    multiTpl: TEMPLATES.SBR_CLIENT_MULTI
  });
  out.push({ to: clientPhone, type: clientMsg.isMulti ? "SBR_CLIENT_MULTI" : "SBR_CLIENT_SINGLE", text: clientMsg.text });

  // each requested barber (ONE compact text per barber)
  for (const [barberId, g] of Object.entries(grouped)) {
    const membersNote = buildMembersNote(g.count, csv(g.indexes));
    out.push({
      to: BARBERS_BY_ID[barberId].phone,
      type: "SBR_BARBER_COMPACT",
      text: TEMPLATES.SBR_BARBER_COMPACT({
        clientName,
        barberName: g.barberName,
        membersNote,
        declined: buildDeclinedFlag(declinedPhotos)
      })
    });
  }

  return out;
}

// event_name: CLIENT_REMOVED_FROM_KIOSK
// when: immediately after client(s) assigned  (per spec you gave; sends client-only)
function planClientRemovedFromKiosk(payload) {
  const { clientName, clientPhone } = payload || {};
  if (!clientName || !clientPhone) throw new Error("CRK: missing clientName or clientPhone");
  return [{ to: clientPhone, type: "CRK_CLIENT", text: TEMPLATES.CRK_CLIENT({ clientName }) }];
}

// event_name: CLIENT_ASSIGNED
// when: immediately after client(s) assigned
function planClientAssigned(payload) {
  const {
    clientName, clientPhone,
    assignments = [], declinedPhotos = false
  } = payload || {};
  if (!clientName || !clientPhone) throw new Error("CA: missing clientName or clientPhone");
  if (!assignments.length) throw new Error("CA: assignments[] required");

  const grouped = groupAssignmentsByBarber(assignments);
  const barberNames = Object.values(grouped).map(g => g.barberName);

  const out = [];

  // client (single vs multi)
  const clientMsg = computeClientSingleOrMultiText({
    names: barberNames,
    clientName,
    singleTpl: TEMPLATES.CA_CLIENT_SINGLE,
    multiTpl: TEMPLATES.CA_CLIENT_MULTI
  });
  out.push({ to: clientPhone, type: clientMsg.isMulti ? "CA_CLIENT_MULTI" : "CA_CLIENT_SINGLE", text: clientMsg.text });

  // each assigned barber (ONE compact text per barber)
  for (const [barberId, g] of Object.entries(grouped)) {
    const membersNote = buildMembersNote(g.count, csv(g.indexes));
    out.push({
      to: BARBERS_BY_ID[barberId].phone,
      type: "CA_BARBER_COMPACT",
      text: TEMPLATES.CA_BARBER_COMPACT({
        clientName,
        barberName: g.barberName,
        membersNote,
        declined: buildDeclinedFlag(declinedPhotos)
      })
    });
  }

  return out;
}

// event_name: CLIENT_PLACED_ON_WAITLIST
// when: immediately after client(s) are placed on the waitlist
// NOTE: uses 'indexLabel' (client's place in line) if you provide it.
function planClientPlacedOnWaitlist(payload) {
  const {
    clientName, clientPhone, indexLabel,
    assignments = [], declinedPhotos = false
  } = payload || {};
  if (!clientName || !clientPhone) throw new Error("CPW: missing clientName or clientPhone");

  const out = [];

  // If specific barbers were selected (assignments non-empty), we mention the names in the client text.
  if (assignments.length) {
    const grouped = groupAssignmentsByBarber(assignments);
    const barberNames = Object.values(grouped).map(g => g.barberName);

    // client (single vs multi)
    const clientMsg = computeClientSingleOrMultiText({
      names: barberNames,
      clientName,
      singleTpl: TEMPLATES.CPW_CLIENT_MULTI, // still use MULTI template, but with one name it's fine
      multiTpl: TEMPLATES.CPW_CLIENT_MULTI
    });
    out.push({ to: clientPhone, type: "CPW_CLIENT_MULTI", text: clientMsg.text });

    // notify only those selected barbers (ONE compact text per barber)
    for (const [barberId, g] of Object.entries(grouped)) {
      const membersNote = buildMembersNote(g.count, csv(g.indexes));
      out.push({
        to: BARBERS_BY_ID[barberId].phone,
        type: "CPW_BARBER_COMPACT",
        text: TEMPLATES.CPW_BARBER_COMPACT({
          clientName,
          membersNote,
          declined: buildDeclinedFlag(declinedPhotos)
        })
      });
    }
  } else {
    // First-available flow: client gets position, and ALL busy + ALL unavailable barbers get pinged
    out.push({
      to: clientPhone,
      type: "CPW_CLIENT_SINGLE",
      text: TEMPLATES.CPW_CLIENT_SINGLE({ clientName, indexLabel: indexLabel ?? "?" })
    });

    const notifySet = new Set([
      ...getBusyBarbers().map(b => b.phone),
      ...getUnavailableBarbers().map(b => b.phone)
    ]);

    for (const phone of notifySet) {
      out.push({
        to: phone,
        type: "CPW_BARBER_COMPACT",
        text: TEMPLATES.CPW_BARBER_COMPACT({
          clientName,
          membersNote: "", // members unknown in first-available placement
          declined: buildDeclinedFlag(declinedPhotos)
        })
      });
    }
  }

  return out;
}

// event_name: CLIENT_RE-WAITLISTED
// when: immediately after client(s) re-waitlisted (pings all busy + all unavailable)
function planClientReWaitlisted(payload) {
  const {
    clientName, clientPhone,
    assignments = [], declinedPhotos = false,
    indexLabel // optional label to include in barber message if you want
  } = payload || {};
  if (!clientName || !clientPhone) throw new Error("CRW: missing clientName or clientPhone");

  const out = [];

  // client (single vs multi based on whether specific barbers were selected)
  if (assignments.length) {
    const grouped = groupAssignmentsByBarber(assignments);
    const barberNames = Object.values(grouped).map(g => g.barberName);
    const clientMsg = computeClientSingleOrMultiText({
      names: barberNames,
      clientName,
      singleTpl: TEMPLATES.CRW_CLIENT_MULTI, // same rationale as CPW
      multiTpl: TEMPLATES.CRW_CLIENT_MULTI
    });
    out.push({ to: clientPhone, type: "CRW_CLIENT_MULTI", text: clientMsg.text });
  } else {
    out.push({ to: clientPhone, type: "CRW_CLIENT_SINGLE", text: TEMPLATES.CRW_CLIENT_SINGLE({ clientName }) });
  }

  // barbers: all busy + all unavailable (ONE compact per barber)
  const notifySet = new Set([
    ...getBusyBarbers().map(b => b.phone),
    ...getUnavailableBarbers().map(b => b.phone)
  ]);

  // If assignments exist, include per-barber membersNote when sending to THAT barber.
  // If no assignments (first-available), no membersNote.
  let grouped = {};
  if (assignments.length) grouped = groupAssignmentsByBarber(assignments);

  for (const b of (ROSTER || [])) {
    if (!notifySet.has(b.phone)) continue;
    const g = grouped[b.id]; // may be undefined
    const membersNote = g ? buildMembersNote(g.count, csv(g.indexes)) : "";
    out.push({
      to: b.phone,
      type: "CRW_BARBER_COMPACT",
      text: TEMPLATES.CRW_BARBER_COMPACT({
        clientName,
        indexLabel,
        membersNote,
        declined: buildDeclinedFlag(declinedPhotos)
      })
    });
  }

  return out;
}
// ======= Fan-out switch =======
// Turns an event { type, payload } into an array of SMS sends.
// Each planner returns: [{ to, type, text }, ...]
function planMessages(type, payload) {
  switch (type) {
    case "SPECIFIC_BARBER_REQUEST": {
      return planSpecificBarberRequest(payload);
    }

    case "CLIENT_REMOVED_FROM_KIOSK": {
      return planClientRemovedFromKiosk(payload);
    }

    case "CLIENT_ASSIGNED": {
      return planClientAssigned(payload);
    }

    case "CLIENT_PLACED_ON_WAITLIST": {
      return planClientPlacedOnWaitlist(payload);
    }

    case "CLIENT_RE-WAITLISTED": {
      return planClientReWaitlisted(payload);
    }

    default:
      throw new Error(`Unknown event type: ${type}`);
  }
}

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

app.get("/", (_req, res) => res.send("OK"));

// --- keywords for compliance ---
const STOP_WORDS  = ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"];
const START_WORDS = ["START", "UNSTOP", "YES"];

// --- Notify kiosk (PHP proxy) to flip a barber's status ---
async function notifyKioskBarberStatus(name, status) {
  try {
    const url = "https://elitekutzkiosk.com/kiosk-api.php?endpoint=barber_status";
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + String(process.env.KIOSK_TOKEN || "")
      },
      body: JSON.stringify({ name, status })
    });
    if (!r.ok) {
      console.warn("notifyKioskBarberStatus failed", r.status, await r.text());
    }
  } catch (e) {
    console.warn("notifyKioskBarberStatus error", e);
  }
}

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

    // Compliance keywords
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

    // --- BARBER AVAILABILITY VIA SMS ---
    if (norm === "AVAILABLE" || norm === "UNAVAILABLE") {
      const fromNormalized = normalizeUS(from);
      const barberName = BARBER_NUMBERS[fromNormalized];

      if (!barberName) {
        await sendSms({
          to: from,
          text: "Elite Kutz: This number is not recognized for barber controls."
        });
        return res.json({ ok: true });
      }

      const status = (norm === "AVAILABLE") ? "available" : "unavailable";
      await notifyKioskBarberStatus(barberName, status);

      await sendSms({
        to: from,
        text: `Elite Kutz: ${barberName} set to ${status.toUpperCase()}.`
      });

      return res.json({ ok: true });
    }

    // Default friendly auto-reply (keep only one)
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

    // >>>>>>>>>>>>>>>>>>>>>>>  END OF PASTED BLOCK  <<<<<<<<<<<<<<<<<<<<<<<<

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
app.post("/api/send-ready", requireKioskAuth, async (req, res) => {
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

app.post("/api/send-assignment", requireKioskAuth, async (req, res) => {
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

// --- Kiosk-triggered: removed from waitlist ---
app.post("/api/send-removed", requireKioskAuth, async (req, res) => {
  try {
    const { to } = req.body || {};
    if (!to) return res.status(400).json({ ok: false, error: "Missing to" });

    const result = await sendSms({
      to,
      text:
        "Elite Kutz: You’ve been removed from the waitlist. If you still need service, please check in again. Reply STOP to opt out, HELP for help, START to rejoin."
    });
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- Kiosk-triggered: position update ---
app.post("/api/send-position", requireKioskAuth, async (req, res) => {
  try {
    const { to, position } = req.body || {};
    if (!to || !Number.isFinite(Number(position))) {
      return res.status(400).json({ ok: false, error: "Missing to/position" });
    }

    const pos = Number(position);
    const result = await sendSms({
      to,
      text:
        `Elite Kutz: You’re #${pos} in line. Keep your phone nearby—reply STOP to opt out, HELP for help, START to rejoin.`
    });
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
// --- Kiosk fan-out endpoint: one event -> many SMS ---
app.post("/events", requireKioskAuth, async (req, res) => {
  try {
    const { type, payload = {} } = req.body || {};
    if (!type) return res.status(400).json({ ok: false, error: "Missing event type" });

    console.log("\n=== /events ===\n", JSON.stringify({ type, payload }, null, 2));

    // Plan messages from the event
    const planned = planMessages(type, payload);
    if (!planned.length) return res.status(400).json({ ok: false, error: "Nothing to send for this event" });

    // Send them all (concurrently)
    const results = await Promise.allSettled(
      planned.map(msg => sendSms({ to: msg.to, text: msg.text }))
    );

    // Basic reporting
    const okCount = results.filter(r => r.status === "fulfilled").length;
    const fail = results
      .map((r, i) => (r.status === "rejected" ? { i, err: String(r.reason) } : null))
      .filter(Boolean);

    return res.json({ ok: true, planned: planned.length, sent: okCount, failed: fail });
  } catch (e) {
    console.error("ERROR /events:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => console.log(`Webhook listening on :${PORT}`));
