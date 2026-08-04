import { useEffect, useRef, useState } from "react";
import type { TournamentState, Winner, TournamentArchive, TournamentRecord, PlayerStats, LeaderboardEntry } from "./types";

const BASE = "/api/tournament";

export async function getState(): Promise<TournamentState> {
  const res = await fetch(`${BASE}/state`);
  if (!res.ok) throw new Error("Failed to fetch state");
  return res.json();
}

export async function postState(state: TournamentState, token: string): Promise<void> {
  const res = await fetch(`${BASE}/state`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(state),
  });
  if (!res.ok) throw new Error("Failed to save state");
}

// 📤 يرفع صورة (data URL) للتخزين الخارجي (Cloudinary) ويرجّع الرابط العام.
// لو التخزين الخارجي غير مهيّأ بالسيرفر، يرمي خطأ والمستدعي يقدر يرجع
// لطريقة Base64 القديمة كـ fallback بدل ما يفشل الحفظ بالكامل.
export async function uploadImage(image: string, token: string, folder?: string): Promise<string> {
  const res = await fetch(`${BASE}/upload`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ image, folder }),
  });
  if (!res.ok) {
    let msg = "فشل رفع الصورة";
    try { const d = await res.json(); msg = d.error || msg; } catch {}
    throw new Error(msg);
  }
  const data = await res.json();
  return data.url as string;
}

export interface StorageStatusItem {
  name: string;
  configured?: boolean;
  mode?: string;
  ok: boolean;
  usedPercent: number | null;
  error?: string;
}
export interface StorageStatusResponse {
  database: StorageStatusItem;
  cloudinary: StorageStatusItem;
}

// 📊 حالة مساحات التخزين (قاعدة البيانات + Cloudinary) لشريط الحالة بلوحة الأدمن.
export async function getStorageStatus(token: string): Promise<StorageStatusResponse | null> {
  try {
    const res = await fetch(`${BASE}/storage/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export interface MigrateImagesResult { migrated: number; skipped: number; failed: number; total: number }

// 🔁 ينقل الصور القديمة المخزّنة Base64 بقاعدة البيانات إلى Cloudinary (تشغيل يدوي لمرة وحدة).
export interface CloudImageEntry {
  url: string;
  publicId: string;
  createdAt: string;
  bytes: number;
  width?: number;
  height?: number;
}

// 🗑️ حذف صورة من السجل (ومن الكرت المرتبط بها لو وُجد).
export async function deleteImage(publicId: string, url: string, token: string): Promise<void> {
  const res = await fetch(`${BASE}/images/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ publicId, url }),
  });
  if (!res.ok) {
    let msg = "فشل حذف الصورة";
    try { const d = await res.json(); msg = d.error || msg; } catch {}
    throw new Error(msg);
  }
}

export interface RecordHistoryEntry {
  id: number;
  tournamentName: string;
  displayName: string;
  winnerName: string;
  image: string;
  savedAt: string;
}

// 📜 السجل التاريخي لكروت البطولات (لقطة عند كل حفظ).
export async function getRecordHistory(token: string, limit = 300): Promise<RecordHistoryEntry[]> {
  const res = await fetch(`${BASE}/records/history?limit=${limit}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    let msg = "فشل جلب السجل";
    try { const d = await res.json(); msg = d.error || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

// 🗑️ حذف لقطة من السجل.
export async function deleteRecordHistory(id: number, token: string): Promise<void> {
  const res = await fetch(`${BASE}/records/history/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ id }),
  });
  if (!res.ok) {
    let msg = "فشل الحذف";
    try { const d = await res.json(); msg = d.error || msg; } catch {}
    throw new Error(msg);
  }
}

// 📜 سجل صور الكروت مع تواريخ رفعها (من Cloudinary مباشرة).
export async function getImagesHistory(token: string): Promise<CloudImageEntry[]> {
  const res = await fetch(`${BASE}/images/history`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    let msg = "فشل جلب سجل الصور";
    try { const d = await res.json(); msg = d.error || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

export async function migrateImages(token: string): Promise<MigrateImagesResult> {
  const res = await fetch(`${BASE}/migrate-images`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    let msg = "فشل نقل الصور";
    try { const d = await res.json(); msg = d.error || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

// قراءة JSON بأمان: لو الرد فاضي أو مو JSON (مثلاً الخادم غير شغّال أو البروكسي رجّع خطأ) ما نرمي خطأ غامض
async function safeJson(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export interface AdminPermissions {
  tournament?: boolean;
  records?: boolean;
}

export interface AdminSession {
  token: string;
  role: "admin" | "helper";
  permissions: AdminPermissions;
  name?: string;
}

export async function adminLogin(password: string): Promise<AdminSession> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
  } catch {
    throw new Error("تعذّر الاتصال بالخادم. تأكد أن خادم الـ API شغّال.");
  }
  const data = await safeJson(res);
  if (!res.ok) {
    throw new Error(data?.error || "تعذّر تسجيل الدخول. تأكد أن خادم الـ API شغّال.");
  }
  if (!data?.token) throw new Error("رد غير متوقع من الخادم");
  return data as AdminSession;
}

// دخول المساعد بكود منحه له الأدمن الرئيسي
export async function adminHelperLogin(code: string): Promise<AdminSession> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/admin/helper-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
  } catch {
    throw new Error("تعذّر الاتصال بالخادم. تأكد أن خادم الـ API شغّال.");
  }
  const data = await safeJson(res);
  if (!res.ok) {
    throw new Error(data?.error || "كود غير صحيح");
  }
  if (!data?.token) throw new Error("رد غير متوقع من الخادم");
  return data as AdminSession;
}

// يتأكد من صلاحية توكن محفوظ ويرجّع دوره وصلاحياته (يُستخدم عند إعادة تحميل الصفحة)
export async function adminWhoami(token: string): Promise<AdminSession | null> {
  try {
    const res = await fetch(`${BASE}/admin/whoami`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = await safeJson(res);
    if (!data?.role) return null;
    return { token, role: data.role, permissions: data.permissions || {} };
  } catch {
    return null;
  }
}

export interface AdminHelper {
  id: number;
  name: string;
  code: string;
  permissions: AdminPermissions;
  createdAt: string;
}

export async function getHelpers(token: string): Promise<AdminHelper[]> {
  const res = await fetch(`${BASE}/admin/helpers`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  return res.json();
}

export async function createHelper(name: string, permissions: AdminPermissions, token: string): Promise<AdminHelper> {
  const res = await fetch(`${BASE}/admin/helpers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name, permissions }),
  });
  const data = await safeJson(res);
  if (!res.ok) throw new Error(data?.error || "فشل إنشاء المساعد");
  return data as AdminHelper;
}

export async function updateHelperPermissions(id: number, permissions: AdminPermissions, token: string): Promise<AdminHelper> {
  const res = await fetch(`${BASE}/admin/helpers/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ permissions }),
  });
  const data = await safeJson(res);
  if (!res.ok) throw new Error(data?.error || "فشل تحديث الصلاحيات");
  return data as AdminHelper;
}

export async function deleteHelper(id: number, token: string): Promise<void> {
  await fetch(`${BASE}/admin/helpers/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
}

// حالة الأدمن التجريبي:
// - "enabled"     → الخادم شغّال وملف dev-admin.txt موجود (ندخل تلقائياً)
// - "disabled"    → الخادم شغّال بس الملف غير موجود (نعرض نموذج كلمة المرور)
// - "unreachable" → ما قدرنا نوصل للخادم (خادم الـ API مو شغّال)
export type DevAdminStatus = "enabled" | "disabled" | "unreachable";

export async function getDevAdminStatus(): Promise<DevAdminStatus> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/admin/dev-status`);
  } catch {
    return "unreachable";
  }
  if (!res.ok) return "unreachable";
  const data = await safeJson(res);
  if (data == null) return "unreachable";
  return data.enabled ? "enabled" : "disabled";
}

// دخول تجريبي بدون كلمة مرور (يشتغل فقط إذا كان الملف موجود)
export async function devAdminLogin(): Promise<AdminSession> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/admin/dev-login`, { method: "POST" });
  } catch {
    throw new Error("تعذّر الاتصال بالخادم. تأكد أن خادم الـ API شغّال.");
  }
  const data = await safeJson(res);
  if (!res.ok) throw new Error(data?.error || "الأدمن التجريبي غير مفعّل");
  if (!data?.token) throw new Error("رد غير متوقع من الخادم");
  return data as AdminSession;
}

export async function getWinners(): Promise<Winner[]> {
  try {
    const res = await fetch(`${BASE}/winners`);
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}

// ⚠️ كانت تبلع كل الأخطاء بصمت: ما تفحص res.ok ولا ترجع شي — فلو رفض
// الخادم الطلب (صلاحية ناقصة / توكن منتهي) تطلع العملية ناجحة والاسم ما
// ينحفظ. الحين ترجع رسالة الخطأ لو فشلت، و null لو نجحت. القيمة المرجّعة
// اختيارية فالاستدعاءات القديمة تشتغل زي ما هي.
export async function postWinner(w: Winner, token: string): Promise<string | null> {
  try {
    const res = await fetch(`${BASE}/winners`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(w),
    });
    if (res.ok) return null;
    let msg = `فشل الحفظ (${res.status})`;
    if (res.status === 401 || res.status === 403) msg = "ما عندك صلاحية إضافة فائزين";
    try { const d = await res.json(); if (d?.error) msg = d.error; } catch {}
    return msg;
  } catch {
    return "تعذّر الاتصال بالخادم";
  }
}

// ✅ useSSE محسّن — يعيد الاتصال تلقائياً ويمنع memory leaks
export function useSSE(onState: (s: TournamentState) => void) {
  const cbRef = useRef(onState);
  cbRef.current = onState;

  useEffect(() => {
    let eventSource: EventSource | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let isActive = true;

    const connect = () => {
      if (!isActive) return;

      try {
        eventSource = new EventSource(`${BASE}/events`);
        console.log("[SSE] Connecting...");

        eventSource.onopen = () => {
          console.log("[SSE] Connected successfully");
        };

        eventSource.onmessage = (e) => {
          try {
            const data = JSON.parse(e.data) as TournamentState;
            console.log("[SSE] Received, phase:", data.phase, "rounds:", data.rounds?.length);
            cbRef.current(data);
          } catch (err) {
            console.error("[SSE] Parse error:", err);
          }
        };

        eventSource.onerror = () => {
          console.error("[SSE] Connection error, reconnecting in 3s...");
          if (eventSource) {
            eventSource.close();
            eventSource = null;
          }
          if (isActive && !reconnectTimeout) {
            reconnectTimeout = setTimeout(() => {
              reconnectTimeout = null;
              connect();
            }, 3000);
          }
        };
      } catch (err) {
        console.error("[SSE] Failed to create connection:", err);
        if (isActive && !reconnectTimeout) {
          reconnectTimeout = setTimeout(() => {
            reconnectTimeout = null;
            connect();
          }, 3000);
        }
      }
    };

    connect();

    return () => {
      isActive = false;
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
      }
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
      console.log("[SSE] Cleanup completed");
    };
  }, []);
}

export function useAdminToken() {
  const [session, setSession] = useState<AdminSession | null>(() => {
    const raw = localStorage.getItem("adminSession");
    if (raw) {
      try { return JSON.parse(raw) as AdminSession; } catch { /* fallthrough */ }
    }
    // توافق مع نسخة قديمة كانت تخزّن التوكن فقط بدون دور/صلاحيات
    const legacyToken = localStorage.getItem("adminToken");
    if (legacyToken) return { token: legacyToken, role: "admin", permissions: { tournament: true, records: true } };
    return null;
  });

  const save = (s: AdminSession) => {
    localStorage.setItem("adminSession", JSON.stringify(s));
    localStorage.removeItem("adminToken");
    setSession(s);
  };

  const clear = () => {
    localStorage.removeItem("adminSession");
    localStorage.removeItem("adminToken");
    setSession(null);
  };

  return {
    token: session?.token ?? null,
    role: session?.role ?? "admin",
    permissions: session?.permissions ?? {},
    save,
    clear,
  };
}

export async function getArchives(): Promise<TournamentArchive[]> {
  try {
    const res = await fetch(`${BASE}/archives`);
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}

export async function getArchive(id: number): Promise<TournamentArchive | null> {
  try {
    const res = await fetch(`${BASE}/archives/${id}`);
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export async function postArchive(archive: Omit<TournamentArchive, "id">, token: string): Promise<TournamentArchive | null> {
  try {
    const res = await fetch(`${BASE}/archives`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(archive),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

// ── سجل البطولات (Tournament Records) ──
export async function getRecords(): Promise<TournamentRecord[]> {
  try {
    const res = await fetch(`${BASE}/records`);
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}

// تعديل/حفظ لعبة (المفتاح = اسم اللعبة tournamentName): اسم الفائز + الصورة + الاسم المخصص. تعديل بدل إضافة.
export async function putRecord(
  record: { tournamentName: string; displayName?: string; winnerName: string; image: string; image2?: string },
  token: string
): Promise<TournamentRecord | null> {
  const res = await fetch(`${BASE}/records`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(record),
  });
  if (!res.ok) {
    let msg = "فشل حفظ السجل";
    try {
      const data = await res.json();
      msg = data.error || msg;
    } catch {}
    throw new Error(msg);
  }
  return res.json();
}

export async function deleteRecord(id: number, token: string): Promise<void> {
  const res = await fetch(`${BASE}/records/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error("فشل حذف السجل");
}

// ── إحصائيات اللاعبين (فوزات + لفل) ──
// جلب فوزات لاعب معيّن لكل لعبة (عام، بدون توكن). يُستخدم للمسجّل بالصفحة العامة وللأدمن.
// 📊 قائمة نظام المستويات: كل اللاعبين ومجموع فوزاتهم (من player_wins).
// ⚠️ ترمي خطأ عند الفشل بدل ما ترجّع [] — عشان لوحة الأدمن تفرّق بين "ما فيه
// لاعبين" و"تعذّر الجلب"، بدل ما تعرض رسالة القائمة الفاضية بالحالتين.
export async function getPlayerLevels(limit = 500): Promise<LeaderboardEntry[]> {
  const res = await fetch(`${BASE}/player/levels?limit=${limit}`);
  if (!res.ok) {
    let msg = "تعذّر جلب قائمة المستويات";
    try {
      const d = await res.json();
      // detail = سبب العطل الحقيقي من الخادم — نعرضه عشان يبان وش الناقص
      msg = d.detail ? `${d.error || msg} (${d.detail})` : (d.error || msg);
    } catch {}
    throw new Error(msg);
  }
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

// 🧹 تصفير نظام المستويات لكل اللاعبين (يمسح فوزات كل الألعاب).
export async function resetAllPlayerWins(token: string): Promise<number> {
  const res = await fetch(`${BASE}/player/wins/reset`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    let msg = "فشل تصفير المستويات";
    try {
      const d = await res.json();
      msg = d.detail ? `${d.error || msg} (${d.detail})` : (d.error || msg);
    } catch {}
    throw new Error(msg);
  }
  const data = await res.json().catch(() => ({}));
  return Number(data?.cleared) || 0;
}

export async function getPlayerStats(username: string): Promise<PlayerStats | null> {
  try {
    const res = await fetch(`${BASE}/player/stats?username=${encodeURIComponent(username)}`);
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

// 🏆 قائمة المتصدّرين: أعلى اللاعبين حسب نقاط الماتشات المكسوبة.
// ⚠️ ترمي خطأ عند الفشل بدل ما ترجّع [] — نفس منطق getPlayerLevels: لوحة الأدمن
// لازم تفرّق بين "ما فيه نقاط" و"تعذّر الجلب". (قبل كذا كان أي عطل بالخادم
// يتحوّل لقائمة فاضية صامتة، فتظهر رسالة "ما فيه نقاط مسجّلة بعد" غلط.)
// الصفحة العامة تستدعيها بـ .catch(() => {}) فما يتأثر شي عندها.
export async function getLeaderboard(limit = 3): Promise<LeaderboardEntry[]> {
  const res = await fetch(`${BASE}/player/leaderboard?limit=${limit}`);
  if (!res.ok) {
    let msg = "تعذّر جلب نقاط الأكثر انتصاراً";
    try {
      const d = await res.json();
      msg = d.detail ? `${d.error || msg} (${d.detail})` : (d.error || msg);
    } catch {}
    throw new Error(msg);
  }
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

// 🏆 تسجيل فوز ماتش للاعب (delta = +1 عند الكسب، -1 عند التراجع).
// فشل صامت عن قصد: عدّاد التوب ما يستاهل يوقف سير البطولة لو تعثّرت الشبكة.
// ✅ ما زال ما يوقف سير البطولة عند الفشل، بس صار يطبع السبب بالكونسول بدل
// الصمت التام — الصمت هو اللي خلّى عطل جدول player_match_wins مخفي لفترة
// طويلة (النقاط ما تنسجّل والقائمة فاضية بلا أي أثر).
export async function addMatchWin(username: string, delta: number, token: string): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/player/match-win`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ username, delta }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      console.warn("⚠️ فشل تسجيل نقطة الأكثر انتصاراً:", d?.detail || d?.error || res.status);
      return false;
    }
    return true;
  } catch (e) {
    console.warn("⚠️ تعذّر الاتصال بالخادم لتسجيل نقطة الأكثر انتصاراً:", e);
    return false;
  }
}

// ✍️ تعيين نقاط التوب للاعب بقيمة صريحة (تحكم يدوي من لوحة الأدمن).
export async function setMatchWins(username: string, wins: number, token: string): Promise<void> {
  const res = await fetch(`${BASE}/player/match-wins`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ username, wins }),
  });
  if (!res.ok) {
    let msg = "فشل تعديل النقاط";
    try { const d = await res.json(); msg = d.error || msg; } catch {}
    throw new Error(msg);
  }
}

// 🧹 تصفير نقاط التوب لكل اللاعبين.
export async function resetAllMatchWins(token: string): Promise<number> {
  const res = await fetch(`${BASE}/player/match-wins/reset`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    let msg = "فشل تصفير النقاط";
    try { const d = await res.json(); msg = d.error || msg; } catch {}
    throw new Error(msg);
  }
  const data = await res.json().catch(() => ({}));
  return Number(data?.cleared) || 0;
}

// تعديل يدوي (تصحيح من الأدمن) لعدد فوزات لاعب في لعبة معيّنة.
export async function setPlayerWins(username: string, game: string, wins: number, token: string): Promise<void> {
  const res = await fetch(`${BASE}/player/wins`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ username, game, wins }),
  });
  if (!res.ok) {
    let msg = "فشل تحديث الفوزات";
    try { const d = await res.json(); msg = d.error || msg; } catch {}
    throw new Error(msg);
  }
}

// إخفاء/إظهار كرت فائز من الصفحة العامة بدون حذف بياناته (اسم الفائز + الصورة يبقون محفوظين).
export async function setRecordVisibility(id: number, isHidden: boolean, token: string): Promise<TournamentRecord | null> {
  const res = await fetch(`${BASE}/records/${id}/visibility`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ isHidden }),
  });
  if (!res.ok) throw new Error("فشل تغيير حالة الظهور");
  return res.json();
}
