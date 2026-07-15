const BASE_URL = "https://www.estonianborder.eu/yphis";
const BOOKING_URL = `${BASE_URL}/anonymousPreReserve.action?request_locale=en`;
const POINTS = [
  { id: "2", name: "Koidula" },
  { id: "3", name: "Luhamaa" },
];

const state = {
  sessions: new Map(),
  lastCheckedAt: null,
  lastResults: [],
  lastAlertFingerprint: null,
  lastAlertAt: 0,
};

class CookieJar {
  constructor() {
    this.values = new Map();
  }

  addFromResponse(response) {
    const raw = typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : splitSetCookieHeader(response.headers.get("set-cookie"));

    for (const item of raw) {
      const first = item.split(";", 1)[0];
      const separator = first.indexOf("=");
      if (separator <= 0) continue;
      this.values.set(first.slice(0, separator).trim(), first.slice(separator + 1).trim());
    }
  }

  toHeader() {
    return [...this.values.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
  }
}

function splitSetCookieHeader(value) {
  if (!value) return [];
  return value.split(/,(?=\s*[^;,]+=)/g);
}

async function fetchWithCookies(path, options, jar, redirectCount = 0) {
  if (redirectCount > 5) throw new Error("Too many GoSwift redirects");

  const headers = new Headers(options?.headers || {});
  const cookie = jar.toHeader();
  if (cookie) headers.set("Cookie", cookie);
  headers.set("User-Agent", "GoSwift availability monitor/1.0 (personal use)");
  headers.set("Accept-Language", "en");

  const response = await fetch(path.startsWith("http") ? path : `${BASE_URL}${path}`, {
    ...options,
    headers,
    redirect: "manual",
  });
  jar.addFromResponse(response);

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location) throw new Error(`GoSwift returned redirect ${response.status} without Location`);
    const nextUrl = new URL(location, response.url).toString();
    return fetchWithCookies(nextUrl, { method: "GET" }, jar, redirectCount + 1);
  }

  if (!response.ok) throw new Error(`GoSwift returned HTTP ${response.status}`);
  return response;
}

function formBody(values) {
  return new URLSearchParams(values).toString();
}

async function postForm(path, values, jar) {
  return fetchWithCookies(path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formBody(values),
  }, jar);
}

async function createSession(point) {
  const jar = new CookieJar();
  await fetchWithCookies(BOOKING_URL, { method: "GET" }, jar);

  await postForm("/preReserveSelectWaitingArea.action", {
    "placeInQueue.vehicleInQueue.vehicleCategory.name": "B",
    "placeInQueue.id": "",
    "placeInQueue.version": "",
  }, jar);

  await postForm("/preReserveSelectQueueType.action", {
    "placeInQueue.borderCrossingPoint.id": point.id,
    "placeInQueue.id": "",
    "placeInQueue.version": "",
  }, jar);

  const ready = await postForm("/preReserveSelectQueueType.action", {
    queueType: "1",
    "action:preReserveSelectTimeslot": "Next",
    "placeInQueue.id": "",
    "placeInQueue.version": "",
  }, jar);
  const readyHtml = await ready.text();
  if (!readyHtml.includes("findOpenTimeslot.action")) {
    throw new Error(`Could not initialize ${point.name} booking session`);
  }

  state.sessions.set(point.id, jar);
  return jar;
}

export function parseFreeSlots(html, targetDate) {
  const slots = [];
  for (const match of html.matchAll(/<div\b[^>]*>/gi)) {
    const tag = match[0];
    const className = tag.match(/class=["']([^"']*)["']/i)?.[1] || "";
    if (!/(^|\s)slotContainer(\s|$)/.test(className)) continue;
    if (!/(^|\s)slotFree(\s|$)/.test(className)) continue;
    const time = tag.match(/data-time=["']([^"']+)["']/i)?.[1];
    if (time?.startsWith(`${targetDate} `)) slots.push(time.slice(11));
  }
  return [...new Set(slots)].sort();
}

async function loadSlots(point, targetDate, retry = true) {
  let jar = state.sessions.get(point.id);
  if (!jar) jar = await createSession(point);

  const response = await fetchWithCookies(
    `/findOpenTimeslot.action?preferredDate=${encodeURIComponent(targetDate)}`,
    { method: "GET" },
    jar,
  );
  const html = await response.text();

  if (!html.includes(`data-preferreddate="${targetDate}"`)) {
    state.sessions.delete(point.id);
    if (retry) return loadSlots(point, targetDate, false);
    throw new Error(`GoSwift session for ${point.name} expired or returned an unexpected page`);
  }

  return parseFreeSlots(html, targetDate);
}

export async function checkPoint(point, targetDate) {
  try {
    const slots = await loadSlots(point, targetDate);
    return { point: point.name, pointId: point.id, slots, ok: true };
  } catch (error) {
    state.sessions.delete(point.id);
    return {
      point: point.name,
      pointId: point.id,
      slots: [],
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function tallinnDateKey(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Tallinn",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get("day")}.${get("month")}.${get("year")}`;
}

function dateKeyToNumber(dateKey) {
  const [day, month, year] = dateKey.split(".").map(Number);
  return year * 10000 + month * 100 + day;
}

export async function sendNtfy(env, title, message, priority = "urgent") {
  if (!env.NTFY_TOPIC) throw new Error("NTFY_TOPIC secret is missing");
  const payload = {
    topic: env.NTFY_TOPIC,
    title,
    message,
    priority,
    tags: ["rotating_light", "car"],
    click: BOOKING_URL,
    actions: [
      { action: "view", label: "Open GoSwift", url: BOOKING_URL, clear: true },
    ],
  };
  const retryDelays = [0, 1_000, 3_000, 7_000];
  let lastError = "Unknown notification error";

  for (let attempt = 0; attempt < retryDelays.length; attempt += 1) {
    if (retryDelays[attempt]) {
      await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
    }

    try {
      const useJsonApi = attempt % 2 === 0;
      const response = await fetch(
        useJsonApi ? "https://ntfy.sh" : `https://ntfy.sh/${encodeURIComponent(env.NTFY_TOPIC)}`,
        useJsonApi ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        } : {
          method: "POST",
          headers: {
            Title: title,
            Priority: priority,
            Tags: "rotating_light,car",
            Click: BOOKING_URL,
          },
          body: message,
        },
      );
      if (response.ok) return;
      const details = (await response.text()).slice(0, 300);
      lastError = `HTTP ${response.status}${details ? `: ${details}` : ""}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  throw new Error(`Notification service failed after ${retryDelays.length} attempts: ${lastError}`);
}

export async function runCheck(env) {
  const targetDate = env.TARGET_DATE || "14.08.2026";
  const today = tallinnDateKey();
  if (dateKeyToNumber(today) > dateKeyToNumber(targetDate)) {
    return { skipped: true, reason: "Target date has passed", targetDate };
  }

  const results = await Promise.all(POINTS.map((point) => checkPoint(point, targetDate)));
  state.lastCheckedAt = new Date().toISOString();
  state.lastResults = results;

  const available = results.filter((result) => result.slots.length > 0);
  if (available.length > 0) {
    const fingerprint = available.map((result) => `${result.point}:${result.slots.join(",")}`).join("|");
    const now = Date.now();
    const shouldRepeat = now - state.lastAlertAt >= 3 * 60 * 1000;
    if (fingerprint !== state.lastAlertFingerprint || shouldRepeat) {
      const lines = available.map((result) => `${result.point}: ${result.slots.join(", ")}`);
      await sendNtfy(
        env,
        `GoSwift: FREE SLOT ${targetDate}`,
        `A slot from Estonia to Russia is available.\n${lines.join("\n")}\nBook immediately: ${BOOKING_URL}`,
      );
      state.lastAlertFingerprint = fingerprint;
      state.lastAlertAt = now;
    }
  } else {
    state.lastAlertFingerprint = null;
  }

  return { checkedAt: state.lastCheckedAt, targetDate, results };
}

export class MonitorCoordinator {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async executeCheck() {
    const startedAt = new Date().toISOString();
    try {
      const result = await runCheck(this.env);
      const status = { running: true, startedAt, ...result };
      await this.ctx.storage.put("lastStatus", status);
      return status;
    } catch (error) {
      const status = {
        running: true,
        startedAt,
        checkedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
      await this.ctx.storage.put("lastStatus", status);
      return status;
    }
  }

  async alarm() {
    const running = await this.ctx.storage.get("running");
    if (!running) return;
    const cycleStartedAt = Date.now();
    try {
      const notificationTestVersion = "ntfy-retry-v1";
      if (await this.ctx.storage.get("notificationTestVersion") !== notificationTestVersion) {
        try {
          await sendNtfy(
            this.env,
            "GoSwift monitor is active",
            "Cloud monitoring and push notifications are working.",
            "high",
          );
          await this.ctx.storage.put("notificationTestVersion", notificationTestVersion);
          await this.ctx.storage.delete("lastNotificationError");
        } catch (error) {
          await this.ctx.storage.put(
            "lastNotificationError",
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      await this.executeCheck();
    } finally {
      if (await this.ctx.storage.get("running")) {
        const nextAlarm = Math.max(cycleStartedAt + 60_000, Date.now() + 5_000);
        await this.ctx.storage.setAlarm(nextAlarm);
      }
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/start") {
      await this.ctx.storage.put("running", true);
      await this.ctx.storage.setAlarm(Date.now() + 1_000);
      return Response.json({ running: true, nextCheck: "within one minute" });
    }
    if (url.pathname === "/stop") {
      await this.ctx.storage.put("running", false);
      await this.ctx.storage.deleteAlarm();
      return Response.json({ running: false });
    }
    if (url.pathname === "/run") {
      return Response.json(await this.executeCheck());
    }

    const running = Boolean(await this.ctx.storage.get("running"));
    const alarm = await this.ctx.storage.getAlarm();
    const lastStatus = await this.ctx.storage.get("lastStatus");
    const lastNotificationError = await this.ctx.storage.get("lastNotificationError");
    return Response.json({
      service: "GoSwift slot monitor",
      direction: "Estonia -> Russia",
      targetDate: this.env.TARGET_DATE || "14.08.2026",
      frequency: "Every 60 seconds",
      running,
      nextAlarmAt: alarm ? new Date(alarm).toISOString() : null,
      lastStatus: lastStatus || null,
      lastNotificationError: lastNotificationError || null,
    }, { headers: { "Cache-Control": "no-store" } });
  }
}

function monitorStub(env) {
  return env.MONITOR.get(env.MONITOR.idFromName("main"));
}

function isAuthorized(url, env) {
  const supplied = url.searchParams.get("key") || "";
  const configured = typeof env.ADMIN_KEY === "string" ? env.ADMIN_KEY : "";
  return Boolean(configured) && supplied.trim() === configured.trim();
}

function unauthorizedResponse(url, env) {
  const supplied = url.searchParams.get("key") || "";
  const configured = typeof env.ADMIN_KEY === "string" ? env.ADMIN_KEY : "";
  return Response.json({
    ok: false,
    error: "Unauthorized",
    keyProvided: Boolean(supplied),
    providedLength: supplied.trim().length,
    adminKeyConfigured: Boolean(configured),
    configuredLength: configured.trim().length,
  }, { status: 401 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/check") {
      if (!isAuthorized(url, env)) {
        return unauthorizedResponse(url, env);
      }
      return monitorStub(env).fetch("https://monitor.internal/run", { method: "POST" });
    }
    if (url.pathname === "/start" || url.pathname === "/stop") {
      if (!isAuthorized(url, env)) {
        return unauthorizedResponse(url, env);
      }
      return monitorStub(env).fetch(`https://monitor.internal${url.pathname}`, { method: "POST" });
    }
    if (url.pathname === "/test-notification") {
      if (!isAuthorized(url, env)) {
        return unauthorizedResponse(url, env);
      }
      try {
        await sendNtfy(env, "GoSwift monitor test", "Notifications are configured correctly.", "high");
        return Response.json({ ok: true, message: "Test notification sent" });
      } catch (error) {
        return Response.json({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }, { status: 502 });
      }
    }
    return monitorStub(env).fetch("https://monitor.internal/status");
  },
};
