import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import PusherLib from "pusher-js";
import bgImg from "@assets/ik3mo-bg-1280_1782771571176.jpg";
import iconImg from "@assets/kemo1_1.icon_1782771567876.png";
import { postState, getState, postArchive, getRecords, putRecord, deleteRecord, setRecordVisibility, getPlayerStats, getPlayerLevels, setPlayerWins, resetAllPlayerWins, addMatchWin, getLeaderboard, getWinners, postWinner, setMatchWins, resetAllMatchWins, getHelpers, createHelper, updateHelperPermissions, deleteHelper, useSSE, uploadImage, getStorageStatus, migrateImages, getImagesHistory, deleteImage, getRecordHistory, deleteRecordHistory, type AdminHelper, type AdminPermissions, type StorageStatusResponse, type CloudImageEntry, type RecordHistoryEntry } from "@/lib/api";
import { BYE, defaultState, levelFromWins, progressWithinLevel, WINS_PER_LEVEL, WINNER_THEMES, WINNER_EMOJIS, type TournamentState, type EntryLogItem, type HistorySnapshot, type TournamentRecord, type PlayerStats, type LeaderboardEntry, type Winner } from "@/lib/types";
import WinnerHistoryBar from "@/components/WinnerHistoryBar";
import {
  p2, buildBracket, doWin, setSize as stSetSize, getOpenMatches, rTitle,
} from "@/lib/tournament";
import { playMatchStart, playWin, playChampion, playStart, isSoundEnabled, toggleSound } from "@/lib/sounds";
import BracketDisplay from "@/components/BracketDisplay";

const CHANNEL_META: Record<string, { chatroomId: number }> = {
  ik3mo: { chatroomId: 5675989 },
  honkfm: { chatroomId: 20137066 },
};

function drawRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

interface Props {
  token: string;
  role: "admin" | "helper";
  permissions: AdminPermissions;
  onLogout: () => void;
}

type SlotState = "idle" | "rolling" | "locked";

// ── 🗣️ أوامر الشات: تُقبل بعلامة ! أو بدونها ──
// ^\s*!?  = تسمح بمسافات بالبداية وعلامة ! اختيارية
// (?:...)  = الكلمة نفسها بالعربي أو الإنجليزي
// (?=$|\s|[^\p{L}\p{N}]) = لازم ينتهي الأمر هنا، فما تنطبق على كلمة أطول
//   مثل "دخولي" أو "الدخول" — يعني الجملة العادية بالشات ما تُحسب انضمام.
const JOIN_CMD = /^\s*!?(?:دخول|join)(?=$|\s|[^\p{L}\p{N}])/iu;
const LEAVE_CMD = /^\s*!?(?:خروج|leave)(?=$|\s|[^\p{L}\p{N}])/iu;

// 🤖 بوتات التجربة تُسمّى "بوت 1"، "بوت 2"... — نستثنيها من كل السجلات
// الدائمة (نظام المستويات ونقاط الأكثر انتصاراً) عشان ما تلوّث الإحصائيات.
function isBotName(name: string): boolean {
  return /^\s*بوت\s*\d+\s*$/.test(name || "");
}

export default function AdminPage({ token, role, permissions, onLogout }: Props) {
  const canTournament = role === "admin" || !!permissions?.tournament;
  const canRecords = role === "admin" || !!permissions?.records;
  const [st, setSt] = useState<TournamentState>(defaultState());
  const [CH, setCH] = useState("ik3mo");
  const [kLive, setKLive] = useState(false);
  const [chatStatus, setChatStatus] = useState<"offline" | "connecting" | "live">("offline");
  const [slotA, setSlotA] = useState("—");
  const [slotB, setSlotB] = useState("—");
  const [slotStateA, setSlotStateA] = useState<SlotState>("idle");
  const [slotStateB, setSlotStateB] = useState<SlotState>("idle");
  const [pickRunning, setPickRunning] = useState(false);
  const [syncError, setSyncError] = useState("");
  const [soundOn, setSoundOn] = useState(true);

  // ⏱️ مدة نافذة الانضمام بالدقائق (يحددها الأدمن قبل ما يفتح الباب)
  const [joinDurationInput, setJoinDurationInput] = useState(1);
  // نبضة كل ثانية عشان العداد التنازلي يتحدث بالواجهة (الوقت الفعلي مخزّن بـ st.joinDeadline)
  // ملاحظة: لازم نستخدم قيمة tick فعلياً (مو بس نتجاهلها بـ [, setTick]) عشان
  // نقدر نحطها بمصفوفة اعتمادات الـ useEffect تاع البدء التلقائي تحت — وإلا
  // الإفكت ما يعاود يتفحص كل ثانية ويضل معلّق حتى لو الوقت خلص فعلاً.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!st.joinDeadline) return;
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [st.joinDeadline]);

  // ⏱️ عندما تنتهي مهلة نافذة الانضمام تلقائيًا، تبدأ البطولة بمفردها (بدون
  // أي تدخل من الأدمن) — طالما فيه عدد لاعبين كافي. لو ما فيه لاعبين كفاية
  // نكتفي بإغلاق الباب فقط (ما نقدر نبدأ ببطولة بدون لاعبين).
  // 🎨 الفائز اللي الأدمن فاتح له لوحة تخصيص الثيم/الإيموجي/اللقب حالياً
  const [editingWinner, setEditingWinner] = useState<Winner | null>(null);

  function saveWinnerCustomization(patch: Partial<Winner>) {
    if (!editingWinner) return;
    const winnerHistory = st.winnerHistory.map(w => w.id === editingWinner.id ? { ...w, ...patch } : w);
    update({ ...st, winnerHistory });
    setEditingWinner(prev => prev ? { ...prev, ...patch } : prev);
  }

  function deleteWinnerRecord(w: Winner) {
    if (!confirm(`حذف سجل الفائز "${w.name}"؟`)) return;
    update({ ...st, winnerHistory: st.winnerHistory.filter(x => x.id !== w.id) });
  }

  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (st.phase !== "setup" || !st.joinDeadline) { autoStartedRef.current = false; return; }
    if (autoStartedRef.current) return;
    if (Date.now() < st.joinDeadline) return;
    autoStartedRef.current = true;
    // ⏯️ ما نبدأ تلقائياً إلا لو مفتاح "بدء تلقائي" مفعّل. لو مقفل (أو ما فيه
    // لاعبين كفاية) نكتفي بإقفال باب الانضمام وننتظر ضغطة "ابدأ البطولة".
    if (st.autoStart && !getStartBlockReason()) {
      startTournament();
    } else {
      update({ ...st, joinDeadline: null });
    }
  }, [st.joinDeadline, st.phase, st.players, st.autoStart, tick]);

  const [records, setRecords] = useState<TournamentRecord[]>([]);
  const [savingGame, setSavingGame] = useState<string | null>(null);
  const [recError, setRecError] = useState("");

  // 📊 حالة مساحات التخزين (قاعدة البيانات + Cloudinary) — تُفحص عند فتح لوحة
  // الأدمن وبعدين كل دقيقة، عشان الشريط يعكس الوضع الحالي فعلياً وليس لحظة الدخول بس.
  const [storageStatus, setStorageStatus] = useState<StorageStatusResponse | null>(null);
  useEffect(() => {
    let cancelled = false;
    const check = () => { getStorageStatus(token).then(s => { if (!cancelled) setStorageStatus(s); }); };
    check();
    const id = setInterval(check, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [token]);

  // 🔁 نقل الصور القديمة (Base64) المخزّنة بقاعدة البيانات إلى Cloudinary — تشغيل يدوي.
  const [migrating, setMigrating] = useState(false);
  const [migrateResult, setMigrateResult] = useState<string>("");
  // ── 📜 سجل صور الكروت (من Cloudinary مع تواريخ الرفع) ──
  const [imgLogOpen, setImgLogOpen] = useState(false);
  const [imgLog, setImgLog] = useState<CloudImageEntry[]>([]);
  const [imgLogBusy, setImgLogBusy] = useState(false);
  const [imgLogErr, setImgLogErr] = useState("");

  const [recLog, setRecLog] = useState<RecordHistoryEntry[]>([]);

  async function openImagesLog() {
    setImgLogOpen(true);
    setImgLogBusy(true);
    setImgLogErr("");
    try {
      // 📜 المصدر: السجل التاريخي بقاعدة البيانات — كل لقطة تحفظ اللعبة
      // والفائز والصورة ووقت الحفظ، فتبقى محفوظة حتى لو تغيّر الكرت بعدين.
      setRecLog(await getRecordHistory(token, 300));
      // نجيب مكتبة الصور كمان عشان خيار "اعرض كل الصور" (استرجاع صورة ضايعة)
      try { setImgLog(await getImagesHistory(token)); } catch { /* اختياري */ }
    } catch (e: any) {
      setImgLogErr(e?.message || "تعذّر جلب السجل");
    } finally {
      setImgLogBusy(false);
    }
  }

  async function removeHistoryRow(id: number) {
    if (imgLogBusy) return;
    if (!confirm("حذف هذا السطر من السجل؟ الكرت والصورة ما يتأثرون.")) return;
    setImgLogBusy(true);
    try {
      await deleteRecordHistory(id, token);
      setRecLog(await getRecordHistory(token, 300));
    } catch (e: any) {
      setImgLogErr(e?.message || "تعذّر الحذف");
    } finally {
      setImgLogBusy(false);
    }
  }

  // 📂 عرض الصور غير المرتبطة بأي كرت — تفيد لاسترجاع صورة انحذفت من
  // الكرت لكن ملفها لسا موجود بمكتبة Cloudinary.
  const [imgLogShowAll, setImgLogShowAll] = useState(false);
  const [linkTarget, setLinkTarget] = useState<Record<string, string>>({});

  // 🔗 يربط صورة موجودة بمكتبة Cloudinary بكرت — استرجاع بضغطة
  async function linkImageToCard(url: string, tournamentName: string) {
    if (!tournamentName || imgLogBusy) return;
    setImgLogBusy(true);
    setImgLogErr("");
    try {
      const rec = records.find(r => r.tournamentName === tournamentName);
      await putRecord({
        tournamentName,
        displayName: rec?.displayName || undefined,
        winnerName: rec?.winnerName || "",
        image: url,
        image2: rec?.image2 || undefined,
      }, token);
      refreshRecords();
      setImgLog(await getImagesHistory(token));
      setRecLog(await getRecordHistory(token, 300));
    } catch (e: any) {
      setImgLogErr(e?.message || "تعذّر ربط الصورة");
    } finally {
      setImgLogBusy(false);
    }
  }

  // ➕ رفع صورة جديدة للمكتبة مباشرة (تظهر بقسم غير المرتبطة لين تربطها بكرت)
  async function addImageToLog(file: File) {
    if (imgLogBusy) return;
    setImgLogBusy(true);
    setImgLogErr("");
    try {
      const processed = await processImage(file);
      await uploadImage(processed, token, "kemo/records");
      setImgLog(await getImagesHistory(token));
      setImgLogShowAll(true);
    } catch (e: any) {
      setImgLogErr(e?.message || "تعذّر رفع الصورة");
    } finally {
      setImgLogBusy(false);
    }
  }

  // 🗑️ حذف صورة نهائياً من مكتبة Cloudinary (ومن الكرت لو مرتبطة)
  async function removeImageFromLog(publicId: string, url: string) {
    if (imgLogBusy) return;
    if (!confirm("حذف هذي الصورة نهائياً من المكتبة؟ ما ترجع.")) return;
    setImgLogBusy(true);
    setImgLogErr("");
    try {
      await deleteImage(publicId, url, token);
      setImgLog(await getImagesHistory(token));
      refreshRecords();
    } catch (e: any) {
      setImgLogErr(e?.message || "تعذّر حذف الصورة");
    } finally {
      setImgLogBusy(false);
    }
  }

  // 📅 نجمّع لقطات السجل حسب يوم الحفظ — كل يوم عنوان كبير وتحته الصور
  const imgLogDays = useMemo(() => {
    const map = new Map<string, { label: string; items: RecordHistoryEntry[] }>();
    for (const row of recLog) {
      if (!row.image) continue;
      const d = new Date(row.savedAt);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      if (!map.has(key)) {
        map.set(key, {
          label: d.toLocaleDateString("ar-SA", {
            weekday: "long", year: "numeric", month: "long", day: "numeric",
          }),
          items: [],
        });
      }
      map.get(key)!.items.push(row);
    }
    return [...map.values()];
  }, [recLog]);

  // 📂 الصور الموجودة بالمكتبة وغير مستخدمة بأي كرت — للاسترجاع
  const orphanImages = useMemo(
    () => imgLog.filter(img => !records.some(r => r.image === img.url || r.image2 === img.url)),
    [imgLog, records],
  );

  async function handleMigrateImages() {
    if (migrating) return;
    setMigrating(true);
    setMigrateResult("");
    try {
      const r = await migrateImages(token);
      setMigrateResult(`✅ تم نقل ${r.migrated} صورة (تجاوزنا ${r.skipped} كانت أصلاً روابط، وفشل ${r.failed})`);
      getStorageStatus(token).then(setStorageStatus);
      if (imgLogOpen) openImagesLog();
    } catch (e: any) {
      setMigrateResult(`❌ ${e?.message || "فشل نقل الصور"}`);
    } finally {
      setMigrating(false);
    }
  }
  // مسودّات أسماء الفائزين لكل لعبة (يتحكم بها المستخدم قبل الحفظ)
  const [winnerDrafts, setWinnerDrafts] = useState<Record<string, string>>({});
  // أسماء الألعاب القابلة للتعديل
  const [gameNames, setGameNames] = useState<Record<string, string>>({});
  const [newGameName, setNewGameName] = useState("");

  const refreshRecords = useCallback(() => {
    getRecords().then((recs) => {
      setRecords(recs);
      // نزامن المسودّات مع القيم المحفوظة (بدون ما ندوس على تعديل جارٍ للمستخدم)
      setWinnerDrafts((prev) => {
        const next = { ...prev };
        for (const r of recs) {
          if (next[r.tournamentName] === undefined) next[r.tournamentName] = r.winnerName || "";
        }
        return next;
      });
    }).catch(() => {});
  }, []);

  useEffect(() => {
    refreshRecords();
  }, [refreshRecords]);

  // ── 🏆 نقاط "الأكثر انتصاراً" (تحكم يدوي كامل من الأدمن) ──
  const [lb, setLb] = useState<LeaderboardEntry[]>([]);
  const [lbLimit, setLbLimit] = useState(10);
  const [lbBusy, setLbBusy] = useState(false);
  const [lbMsg, setLbMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [lbDraft, setLbDraft] = useState<Record<string, string>>({});
  // ❗ خطأ الجلب ينحفظ لحاله: قبل كذا كان الفشل يُبلع بصمت فتظهر رسالة
  // "ما فيه نقاط مسجّلة بعد" حتى لو المشكلة عطل بالخادم مو قائمة فاضية.
  const [lbError, setLbError] = useState("");
  const [lbNewName, setLbNewName] = useState("");
  const [lbNewPts, setLbNewPts] = useState(1);
  // 🔎 فلتر بالاسم — نفس فكرة فلتر نظام المستويات: يصفّي القائمة المحمّلة
  // بدون ما يرجع للخادم، والترتيب والمراكز تبقى كما هي بالقائمة الأصلية.
  const [lbQuery, setLbQuery] = useState("");
  const lbFiltered = useMemo(() => {
    const q = lbQuery.trim().toLowerCase();
    // نحتفظ بالمركز الأصلي عشان 🥇🥈🥉 ما تتغيّر مع الفلترة
    const withRank = lb.map((row, i) => ({ row, rank: i }));
    return q ? withRank.filter(x => x.row.username.toLowerCase().includes(q)) : withRank;
  }, [lb, lbQuery]);

  async function loadLeaderboard(limit = lbLimit) {
    setLbBusy(true);
    try {
      const rows = await getLeaderboard(limit);
      // 🤖 نخفي بوتات التجربة من قائمة الأكثر انتصاراً
      setLb((rows || []).filter(r => !isBotName(r.username)));
      setLbDraft({});
      setLbError("");
    } catch (e: any) {
      setLb([]);
      setLbError(e?.message || "تعذّر جلب نقاط الأكثر انتصاراً");
    } finally {
      setLbBusy(false);
    }
  }

  // تعيين قيمة صريحة لنقاط لاعب (تشمل الصفر = تصفير فردي)
  async function applyPoints(username: string, value: number) {
    if (!token) return;
    setLbBusy(true);
    setLbMsg(null);
    try {
      await setMatchWins(username, Math.max(0, Math.floor(value)), token);
      setLbMsg({ ok: true, text: `تم تحديث نقاط ${username} إلى ${Math.max(0, Math.floor(value))}` });
      await loadLeaderboard();
    } catch (err) {
      setLbMsg({ ok: false, text: err instanceof Error ? err.message : "فشل التعديل" });
    } finally {
      setLbBusy(false);
    }
  }

  async function resetAllPoints() {
    if (!token) return;
    if (!window.confirm("تصفير نقاط كل اللاعبين نهائياً؟ ما يمكن التراجع.")) return;
    setLbBusy(true);
    setLbMsg(null);
    try {
      const cleared = await resetAllMatchWins(token);
      setLbMsg({ ok: true, text: `تم تصفير النقاط (${cleared} لاعب)` });
      await loadLeaderboard();
    } catch (err) {
      setLbMsg({ ok: false, text: err instanceof Error ? err.message : "فشل التصفير" });
    } finally {
      setLbBusy(false);
    }
  }

  useEffect(() => { if (token) loadLeaderboard(); /* eslint-disable-next-line */ }, [token]);

  // ── بحث إحصائيات اللاعبين (فوزات + لفل لكل لعبة) ──
  const [statsQuery, setStatsQuery] = useState("");
  const [statsData, setStatsData] = useState<PlayerStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState("");
  const [lvlPage, setLvlPage] = useState(0);   // صفحة قائمة المستويات (8 بالصفحة)
  const LVL_PER_PAGE = 8;
  const [statsSearched, setStatsSearched] = useState("");

  // 📋 قائمة نظام المستويات — المصدر: جدول player_wins نفسه عبر
  // getPlayerLevels. (قبل كذا كان المصدر سجل الفائزين getWinners، وهو جدول
  // مختلف تماماً عن اللي يُبنى عليه المستوى — فيطلع تعارض: رقم بالقائمة
  // ولفل مختلف بالكرت، والإضافة اليدوية ما تظهر.)
  const [lvlPlayers, setLvlPlayers] = useState<LeaderboardEntry[]>([]);
  const [lvlBusy, setLvlBusy] = useState(false);
  // ❗ خطأ الجلب ينحفظ لحاله: قبل كذا كان الفشل يُبلع بصمت (catch فاضي) فتظهر
  // رسالة "ما فيه لاعب له فوزات بعد" حتى لو المشكلة عطل بالخادم مو قائمة فاضية.
  const [lvlError, setLvlError] = useState("");
  const [lvlMsg, setLvlMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const refreshLvlPlayers = useCallback(() => {
    getPlayerLevels(500)
      .then(rows => { setLvlPlayers(rows || []); setLvlError(""); })
      .catch(e => setLvlError(e?.message || "تعذّر جلب قائمة المستويات"));
  }, []);
  useEffect(() => { refreshLvlPlayers(); }, [refreshLvlPlayers]);

  // 🧹 تصفير نظام المستويات كامل — نفس فكرة "تصفير الكل" بنقاط الأكثر انتصاراً،
  // بس على جدول ثاني: هذا يمسح فوزات الكروت (اللفل)، وذاك يمسح نقاط الماتشات.
  async function resetAllLevels() {
    if (!token || lvlBusy) return;
    if (!window.confirm("تصفير مستويات كل اللاعبين نهائياً؟ تُمسح فوزاتهم في كل الألعاب وما يمكن التراجع.")) return;
    setLvlBusy(true);
    setLvlMsg(null);
    try {
      const cleared = await resetAllPlayerWins(token);
      setLvlMsg({ ok: true, text: `تم تصفير المستويات (${cleared} لاعب)` });
      setStatsData(null);
      setStatsSearched("");
      setLvlPage(0);
      refreshLvlPlayers();
    } catch (e: any) {
      setLvlMsg({ ok: false, text: e?.message || "فشل تصفير المستويات" });
    } finally {
      setLvlBusy(false);
    }
  }

  // ↺ تصفير لاعب واحد: نصفّر فوزاته في كل لعبة عنده (بدون ما نلمس البقية).
  async function resetOnePlayerLevel(name: string) {
    if (!token || lvlBusy || !name) return;
    if (!window.confirm(`تصفير مستويات "${name}" في كل الألعاب؟`)) return;
    setLvlBusy(true);
    setLvlMsg(null);
    try {
      const wins = (await getPlayerStats(name))?.wins || {};
      const games = Object.keys(wins).filter(g => (wins[g] || 0) > 0);
      for (const g of games) await setPlayerWins(name, g, 0, token);
      setLvlMsg({ ok: true, text: `تم تصفير مستويات ${name}` });
      if (statsSearched.toLowerCase() === name.toLowerCase()) setStatsData({ username: name, wins: {} });
      refreshLvlPlayers();
    } catch (e: any) {
      setLvlMsg({ ok: false, text: e?.message || "فشل تصفير اللاعب" });
    } finally {
      setLvlBusy(false);
    }
  }
  const refreshLvlWinnersRef = useRef(refreshLvlPlayers);
  refreshLvlWinnersRef.current = refreshLvlPlayers;

  // ── ➕ إضافة لاعب يدوياً لنظام المستويات ──
  // كل "فوز" = سجل فائز واحد بسجل البطولات، فالإضافة تكتب N سجلات.
  // ولو حددت لعبة، نحدّث كمان فوزاته فيها عشان لفله بالكرت يتغيّر فعلاً.
  const [addName, setAddName] = useState("");
  const [addWins, setAddWins] = useState(1);
  const [addGame, setAddGame] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addMsg, setAddMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function addManualWinner() {
    const name = addName.trim();
    const game = addGame.trim();
    const n = Math.max(1, Math.min(200, Math.floor(addWins) || 1));
    if (!name || addBusy) return;
    if (!game) { setAddMsg({ ok: false, text: "⚠️ اختر اللعبة — المستويات تُحسب لكل لعبة على حدة" }); return; }
    setAddBusy(true);
    setAddMsg(null);
    try {
      // نقرأ فوزاته الحالية باللعبة ونضيف عليها (ما نمسح القديم)
      const cur = await getPlayerStats(name).catch(() => null);
      const before = cur?.wins?.[game] ?? 0;
      await setPlayerWins(name, game, before + n, token);
      refreshLvlPlayers();
      if (statsSearched.toLowerCase() === name.toLowerCase()) loadPlayerStats(name);
      setAddMsg({ ok: true, text: `✅ ${name} صار عنده ${before + n} فوز في "${game}" — المستوى ${levelFromWins(before + n)}` });
      setAddName("");
      setAddWins(1);
    } catch (e: any) {
      setAddMsg({ ok: false, text: e?.message || "⚠️ تعذّرت الإضافة" });
    } finally {
      setAddBusy(false);
    }
  }

  const lvlFiltered = useMemo(() => {
    // نستثني: من ما عنده ولا فوز، وبوتات التجربة
    const clean = lvlPlayers.filter(p => (p.wins || 0) > 0 && !isBotName(p.username));
    const q = statsQuery.trim().toLowerCase();
    return q ? clean.filter(p => p.username.toLowerCase().includes(q)) : clean;
  }, [lvlPlayers, statsQuery]);

  async function loadPlayerStats(nameArg?: string) {
    const name = (nameArg ?? statsQuery).trim();
    if (!name) return;
    setStatsLoading(true);
    setStatsError("");
    try {
      const data = await getPlayerStats(name);
      setStatsData(data || { username: name, wins: {} });
      setStatsSearched(name);
    } catch {
      setStatsError("تعذّر جلب الإحصائيات");
    } finally {
      setStatsLoading(false);
    }
  }

  // تعديل يدوي (+1/-1) لفوزات لاعب في لعبة — تصحيح من الأدمن.
  // (نحدّث قائمة المستويات بعده عشان الرقم بالقائمة يطابق التفاصيل فوراً)
  async function adjustPlayerWin(game: string, delta: number) {
    if (!statsSearched) return;
    const current = statsData?.wins?.[game] ?? 0;
    const next = Math.max(0, current + delta);
    // تحديث تفاؤلي فوري
    setStatsData((prev) => prev ? { ...prev, wins: { ...prev.wins, [game]: next } } : prev);
    try {
      await setPlayerWins(statsSearched, game, next, token);
    } catch (e: any) {
      setStatsError(e?.message || "تعذّر تحديث الفوزات");
      // نرجّع القيمة الصحيحة من الخادم لو فشل
      const data = await getPlayerStats(statsSearched);
      if (data) setStatsData(data);
    }
    refreshLvlPlayers();
  }

  const [helpersOpen, setHelpersOpen] = useState(false);
  // ── إدارة المساعدين (الأدمن الرئيسي فقط) ──
  const [helpers, setHelpers] = useState<AdminHelper[]>([]);
  const [helperName, setHelperName] = useState("");
  const [newHelperPerms, setNewHelperPerms] = useState<AdminPermissions>({ tournament: true, records: false });
  const [helperError, setHelperError] = useState("");
  const [creatingHelper, setCreatingHelper] = useState(false);
  const [revealedCode, setRevealedCode] = useState<{ name: string; code: string } | null>(null);

  const refreshHelpers = useCallback(() => {
    if (role !== "admin") return;
    getHelpers(token).then(setHelpers).catch(() => {});
  }, [role, token]);

  useEffect(() => {
    refreshHelpers();
  }, [refreshHelpers]);

  async function handleCreateHelper() {
    if (!helperName.trim()) return;
    setCreatingHelper(true);
    setHelperError("");
    try {
      const helper = await createHelper(helperName.trim(), newHelperPerms, token);
      setHelperName("");
      setNewHelperPerms({ tournament: true, records: false });
      setRevealedCode({ name: helper.name, code: helper.code });
      refreshHelpers();
    } catch (err: unknown) {
      setHelperError(err instanceof Error ? err.message : "فشل إنشاء المساعد");
    } finally {
      setCreatingHelper(false);
    }
  }

  async function handleToggleHelperPerm(h: AdminHelper, key: keyof AdminPermissions) {
    const nextPerms = { ...h.permissions, [key]: !h.permissions?.[key] };
    setHelpers((prev) => prev.map((x) => (x.id === h.id ? { ...x, permissions: nextPerms } : x)));
    try {
      await updateHelperPermissions(h.id, nextPerms, token);
    } catch {
      refreshHelpers();
    }
  }

  async function handleDeleteHelper(h: AdminHelper) {
    setHelpers((prev) => prev.filter((x) => x.id !== h.id));
    try {
      await deleteHelper(h.id, token);
    } catch {
      refreshHelpers();
    }
  }

  // يقرأ الصورة ويصغّرها (حد أقصى 1000px، JPEG) ويرجّع Base64 data URL.
  function processImage(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const img = new Image();
        img.onload = () => {
          const MAX = 1000;
          let { width, height } = img;
          if (width > MAX || height > MAX) {
            const scale = Math.min(MAX / width, MAX / height);
            width = Math.round(width * scale);
            height = Math.round(height * scale);
          }
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          if (!ctx) { resolve(dataUrl); return; }
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL("image/jpeg", 0.85));
        };
        img.onerror = () => resolve(dataUrl);
        img.src = dataUrl;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // حفظ لعبة (upsert بمفتاح اسم اللعبة): اسم الفائز + الصورة معاً.
  async function saveGame(game: string, winnerName: string, image: string) {
    setRecError("");
    setSavingGame(game);
    try {
      await putRecord({ tournamentName: game, winnerName, image }, token);
      refreshRecords();
    } catch (e: any) {
      setRecError(e?.message || "تعذّر الحفظ");
    } finally {
      setSavingGame(null);
    }
  }

  // رفع صورة لعبة: يقرأ الملف ويصغّره، يرفعه للتخزين الخارجي (Cloudinary) ويحفظ
  // الرابط الراجع مع اسم الفائز الحالي. لو رفع التخزين الخارجي فشل (مثلاً السيرفر
  // ما عنده مفاتيح Cloudinary بعد)، نرجع نحفظ الصورة Base64 مباشرة عشان الميزة
  // تفضل شغالة بدون ما توقف الأدمن.
  async function handleGameImage(game: string, file: File, currentWinner: string) {
    setRecError("");
    if (!file.type.startsWith("image/")) {
      setRecError("الملف المختار ليس صورة");
      return;
    }
    try {
      const processed = await processImage(file);
      let image = processed;
      try {
        image = await uploadImage(processed, token, "kemo/records");
      } catch {
        // فشل الرفع الخارجي — نكمل بالـ Base64 كـ fallback بدل ما نوقف الحفظ
      }
      await saveGame(game, currentWinner, image);
    } catch {
      setRecError("تعذّر قراءة الصورة");
    }
  }

  // رفع الصورة الإضافية (image2) — نفس منطق الرفع الخارجي مع fallback لـ Base64.
  async function handleGameImage2(game: string, file: File, currentWinner: string, currentImage: string) {
    setRecError("");
    if (!file.type.startsWith("image/")) {
      setRecError("الملف المختار ليس صورة");
      return;
    }
    setSavingGame(game);
    try {
      const processed = await processImage(file);
      let image2 = processed;
      try {
        image2 = await uploadImage(processed, token, "kemo/records");
      } catch {
        // فشل الرفع الخارجي — نكمل بالـ Base64 كـ fallback
      }
      await putRecord({ tournamentName: game, winnerName: currentWinner, image: currentImage, image2 }, token);
      refreshRecords();
    } catch (e: any) {
      setRecError(e?.message || "تعذّر قراءة الصورة");
    } finally {
      setSavingGame(null);
    }
  }

  // حذف الصورة الإضافية فقط (image2) مع الإبقاء على باقي بيانات اللعبة.
  async function handleClearGameImage2(game: string, currentWinner: string, currentImage: string) {
    setRecError("");
    setSavingGame(game);
    try {
      await putRecord({ tournamentName: game, winnerName: currentWinner, image: currentImage, image2: "" }, token);
      refreshRecords();
    } catch (e: any) {
      setRecError(e?.message || "تعذّر حذف الصورة");
    } finally {
      setSavingGame(null);
    }
  }

  // حفظ اسم الفائز (عند الخروج من الحقل) مع الإبقاء على الصورة الحالية.
  function handleWinnerBlur(game: string, currentImage: string, savedWinner: string) {
    const draft = (winnerDrafts[game] ?? "").trim();
    if (draft === (savedWinner || "").trim()) return; // لا تغيير
    saveGame(game, draft, currentImage);
  }

  // حفظ اسم اللعبة المعدل
  async function handleGameNameBlur(game: string, newName: string, currentWinner: string, currentImage: string) {
    const trimmedName = (newName || "").trim();
    if (trimmedName === game) return; // لا تغيير
    setRecError("");
    setSavingGame(game);
    try {
      await putRecord({
        tournamentName: game,
        displayName: trimmedName,
        winnerName: currentWinner,
        image: currentImage
      }, token);
      refreshRecords();
    } catch (e: any) {
      setRecError(e?.message || "تعذّر حفظ الاسم");
    } finally {
      setSavingGame(null);
    }
  }

  function drawHeader(ctx: CanvasRenderingContext2D, W: number, title: string, winner: string, trophyY: number, titleY: number) {
    ctx.textAlign = "center";
    ctx.font = "48px 'Segoe UI Emoji','Noto Color Emoji',sans-serif";
    ctx.fillText("🏆", W / 2, trophyY);
    const tName = (title || "بطولة").trim();
    ctx.fillStyle = "#ffffff";
    ctx.font = "900 26px Tahoma, Arial, sans-serif";
    ctx.fillText(tName, W / 2, titleY);
    if (!winner) return titleY + 20;
    ctx.font = "900 20px Tahoma, Arial, sans-serif";
    const label = `👑 ${winner} 👑`;
    const bw = Math.min(560, Math.max(180, ctx.measureText(label).width + 60));
    const bx = W / 2 - bw / 2;
    const by = titleY + 16;
    const bh = 42;
    ctx.fillStyle = "rgba(255,215,0,0.14)";
    ctx.strokeStyle = "rgba(255,215,0,0.55)";
    ctx.lineWidth = 2;
    drawRoundRect(ctx, bx, by, bw, bh, 21);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#ffd700";
    ctx.fillText(label, W / 2, by + 28);
    return by + bh;
  }

  // يولّد صورة من بيانات البطولة الحالية (البراكيت + الفائز) ويرجّعها كـ data URL،
  // أو null لو ما فيه بيانات كافية (مع رسالة خطأ). العنوان = اسم البطولة الحالية.
  function generateBracketImage(winner: string): string | null {
    const rounds = st.rounds || [];
    const allPlayers = (st.players || []).filter(p => p && p !== BYE);
    const title = st.name || "بطولة";
    if (rounds.length === 0 && allPlayers.length === 0 && !winner) {
      setRecError("ما كاين بيانات بطولة حالية (لا براكيت ولا منافسين) باش نولّدو منها صورة");
      return null;
    }
    if (rounds.length > 0) {
      const totalRounds = rounds.length;
      const matchW = 190, matchH = 58, rowH = 92, colGap = 60;
      const colW = matchW + colGap;
      const marginX = 40, headerH = 190;
      const centersY: number[][] = [];
      centersY[0] = rounds[0].map((_, i) => headerH + i * rowH + rowH / 2);
      for (let r = 1; r < totalRounds; r++) {
        centersY[r] = rounds[r].map((_, i) => {
          const y1 = centersY[r - 1][2 * i];
          const y2 = centersY[r - 1][2 * i + 1];
          if (y1 !== undefined && y2 !== undefined) return (y1 + y2) / 2;
          return y1 ?? y2 ?? headerH;
        });
      }
      const maxY = Math.max(...centersY[0]) + rowH / 2 + 50;
      const W = marginX * 2 + totalRounds * colW - colGap;
      const H = Math.max(560, maxY + 40);
      const canvas = document.createElement("canvas");
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      const bgGrad = ctx.createLinearGradient(0, 0, W, H);
      bgGrad.addColorStop(0, "#0a1a33");
      bgGrad.addColorStop(1, "#020814");
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, W, H);
      const glow = ctx.createRadialGradient(W / 2, 60, 10, W / 2, 60, 320);
      glow.addColorStop(0, "rgba(255,215,0,0.28)");
      glow.addColorStop(1, "rgba(255,215,0,0)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = "rgba(41,182,246,0.35)";
      ctx.lineWidth = 3;
      ctx.strokeRect(5, 5, W - 10, H - 10);
      drawHeader(ctx, W, title, winner, 58, 96);
      ctx.strokeStyle = "rgba(41,182,246,0.4)";
      ctx.lineWidth = 2;
      for (let r = 0; r < totalRounds - 1; r++) {
        const x1 = marginX + r * colW + matchW;
        const x2 = marginX + (r + 1) * colW;
        const midX = (x1 + x2) / 2;
        rounds[r + 1].forEach((_, i) => {
          const targetY = centersY[r + 1][i];
          [2 * i, 2 * i + 1].forEach((si) => {
            const sourceY = centersY[r][si];
            if (sourceY === undefined) return;
            ctx.beginPath();
            ctx.moveTo(x1, sourceY);
            ctx.lineTo(midX, sourceY);
            ctx.lineTo(midX, targetY);
            ctx.lineTo(x2, targetY);
            ctx.stroke();
          });
        });
      }
      ctx.textAlign = "center";
      rounds.forEach((round, r) => {
        const x = marginX + r * colW;
        const isFinal = r === totalRounds - 1;
        ctx.fillStyle = "rgba(255,255,255,0.55)";
        ctx.font = "700 13px Tahoma, Arial, sans-serif";
        ctx.fillText(rTitle(r, totalRounds).replace("🏆", "").trim(), x + matchW / 2, headerH - 18);
        round.forEach((m, i) => {
          const cy = centersY[r][i];
          const y = cy - matchH / 2;
          ctx.fillStyle = isFinal ? "rgba(255,215,0,0.08)" : "rgba(41,182,246,0.08)";
          ctx.strokeStyle = isFinal ? "rgba(255,215,0,0.5)" : "rgba(41,182,246,0.35)";
          ctx.lineWidth = 1.5;
          drawRoundRect(ctx, x, y, matchW, matchH, 10);
          ctx.fill();
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(x, cy);
          ctx.lineTo(x + matchW, cy);
          ctx.strokeStyle = "rgba(255,255,255,0.12)";
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.strokeStyle = isFinal ? "rgba(255,215,0,0.5)" : "rgba(41,182,246,0.35)";
          ctx.lineWidth = 1.5;
          const half = matchH / 2;
          const drawSlot = (name: string | null, slotY: number) => {
            const isBye = name === BYE;
            const isW = !!m.winner && m.winner === name && name !== BYE;
            ctx.font = `${isW ? "800" : "500"} 14px Tahoma, Arial, sans-serif`;
            ctx.fillStyle = isW ? "#ffd700" : isBye ? "rgba(255,255,255,0.35)" : name ? "#e5e7eb" : "rgba(255,255,255,0.3)";
            let label = isBye ? "بايب" : name || "—";
            const maxW = matchW - 20;
            if (ctx.measureText(label).width > maxW) {
              while (label.length > 3 && ctx.measureText(label + "…").width > maxW) {
                label = label.slice(0, -1);
              }
              label += "…";
            }
            ctx.fillText(label, x + matchW / 2, slotY);
          };
          drawSlot(m.a, y + half / 2 + 5);
          drawSlot(m.b, y + half + half / 2 + 5);
        });
      });
      return canvas.toDataURL("image/jpeg", 0.9);
    }
    const others = allPlayers.filter(p => p !== winner);
    const W = 1000, H = 625;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const bgGrad = ctx.createLinearGradient(0, 0, W, H);
    bgGrad.addColorStop(0, "#0a1a33");
    bgGrad.addColorStop(1, "#020814");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, W, H);
    const glow = ctx.createRadialGradient(W / 2, 120, 10, W / 2, 120, 260);
    glow.addColorStop(0, "rgba(255,215,0,0.35)");
    glow.addColorStop(1, "rgba(255,215,0,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "rgba(41,182,246,0.35)";
    ctx.lineWidth = 3;
    ctx.strokeRect(6, 6, W - 12, H - 12);
    const afterHeader = drawHeader(ctx, W, title, winner, 95, 150);
    const listStartY = afterHeader + 34;
    if (others.length > 0) {
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.font = "700 16px Tahoma, Arial, sans-serif";
      ctx.fillText(`المنافسون (${allPlayers.length})`, W / 2, listStartY);
      const gridTop = listStartY + 34;
      const cols = 4;
      const cellW = (W - 80) / cols;
      const rowH = 44;
      const maxRows = Math.max(1, Math.floor((H - gridTop - 30) / rowH));
      const shown = others.slice(0, cols * maxRows);
      shown.forEach((name, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const cx = 40 + cellW * col + cellW / 2;
        const cy = gridTop + row * rowH;
        ctx.fillStyle = "rgba(255,255,255,0.08)";
        drawRoundRect(ctx, cx - cellW / 2 + 8, cy - 22, cellW - 16, 34, 10);
        ctx.fill();
        ctx.fillStyle = "#e5e7eb";
        ctx.font = "600 15px Tahoma, Arial, sans-serif";
        let display = name;
        const maxW = cellW - 30;
        if (ctx.measureText(display).width > maxW) {
          while (display.length > 3 && ctx.measureText(display + "…").width > maxW) {
            display = display.slice(0, -1);
          }
          display += "…";
        }
        ctx.fillText(display, cx, cy + 5);
      });
      if (others.length > shown.length) {
        ctx.fillStyle = "rgba(255,255,255,0.5)";
        ctx.font = "600 14px Tahoma, Arial, sans-serif";
        ctx.fillText(`+${others.length - shown.length} آخرين`, W / 2, H - 18);
      }
    }
    return canvas.toDataURL("image/jpeg", 0.9);
  }

  // يولّد صورة البراكيت الحالي ويحفظها لهذي اللعبة (مع اسم الفائز الحالي أو بطل البطولة).
  async function handleGenerateGameImage(game: string) {
    setRecError("");
    // 🏆 لو فيه براكيت حقيقي، اسم الفائز لازم يجي من نتيجة البراكيت الفعلية
    // (آخر ماتش بالنهائي) — مو من خانة الاسم اللي الأدمن يكتبها يدوياً. قبل
    // هذا التعديل كانت الصورة المولّدة ممكن تطلع فيها اسمين متناقضين: الشارة
    // الذهبية تكتب اسم مختلف عن اللي فعلاً فايز بالبراكيت المرسوم تحتها.
    const rounds = st.rounds || [];
    const bracketChampion = rounds.length ? (rounds[rounds.length - 1][0]?.winner || "") : "";
    const realChampion = (bracketChampion && bracketChampion !== BYE) ? bracketChampion : "";
    const winner = realChampion || (winnerDrafts[game] ?? "").trim() || (st.champion || "").trim();
    const image = generateBracketImage(winner);
    if (!image) return;
    await saveGame(game, winner, image);
  }

  // تفريغ لعبة (يمسح اسم الفائز والصورتين بس الكرت يبقى موجود بنفس الاسم).
  // إخفاء/إظهار كرت الفائز عن الصفحة العامة (بدون حذف الاسم أو الصورة، ويرجع بأي وقت)
  async function toggleGameVisibility(rec: TournamentRecord) {
    setRecError("");
    setSavingGame(rec.tournamentName);
    try {
      await setRecordVisibility(rec.id, !rec.isHidden, token);
      refreshRecords();
    } catch (e: any) {
      setRecError(e?.message || "تعذّر تغيير حالة الظهور");
    } finally {
      setSavingGame(null);
    }
  }

  async function handleClearGame(rec: TournamentRecord) {
    if (!confirm(`تفريغ "${rec.displayName || rec.tournamentName}" (اسم الفائز والصورة)؟`)) return;
    setSavingGame(rec.tournamentName);
    try {
      await putRecord({ tournamentName: rec.tournamentName, displayName: rec.displayName || "", winnerName: "", image: "", image2: "" }, token);
      setWinnerDrafts((prev) => ({ ...prev, [rec.tournamentName]: "" }));
      refreshRecords();
    } catch {
      setRecError("فشل التفريغ");
    } finally {
      setSavingGame(null);
    }
  }

  // حذف الكرت نهائيًا: يشيل السجل بالكامل من قاعدة البيانات فيختفي الكرت
  // كامل من صفحة الأدمن وصفحة الزوار، ولا يرجع إلا بإضافته من جديد.
  async function handleDeleteGameCard(rec: TournamentRecord) {
    if (!confirm(`حذف كرت "${rec.displayName || rec.tournamentName}" نهائيًا؟ هاذي العملية ما ترجعش، غير إضافة كرت جديد بنفس الاسم.`)) return;
    setRecError("");
    setSavingGame(rec.tournamentName);
    try {
      await deleteRecord(rec.id, token);
      setWinnerDrafts((prev) => {
        const next = { ...prev };
        delete next[rec.tournamentName];
        return next;
      });
      setGameNames((prev) => {
        const next = { ...prev };
        delete next[rec.tournamentName];
        return next;
      });
      refreshRecords();
    } catch {
      setRecError("فشل حذف الكرت");
    } finally {
      setSavingGame(null);
    }
  }

  // إضافة كرت جديد: يعمل سجل جديد فاضي بالاسم إللي يكتبه الأدمن، يظهر مباشرة كخانة جديدة.
  async function handleAddGame() {
    const name = newGameName.trim();
    if (!name) {
      // 🐛 قبل: كان يرجع بصمت بدون أي رسالة، فيبان الزر "ميت" لما الحقل فاضي
      // (خصوصاً إن الزر ما عنده أي شكل مرئي مختلف وهو معطّل). دابا نوضّح
      // بالضبط ليش ما ضاف شي.
      setRecError("⚠️ لازم تكتب اسم اللعبة/الكرت الجديد فالحقل قبل ما تضغط");
      return;
    }
    if (records.some((r) => r.tournamentName === name)) {
      setRecError("فما كرت بنفس الاسم موجود من قبل");
      return;
    }
    setRecError("");
    setSavingGame(name);
    try {
      await putRecord({ tournamentName: name, winnerName: "", image: "" }, token);
      setNewGameName("");
      refreshRecords();
    } catch (e: any) {
      setRecError(e?.message || "تعذّر إضافة الكرت");
    } finally {
      setSavingGame(null);
    }
  }

  useEffect(() => {
    setSoundOn(isSoundEnabled());
  }, []);

  function handleToggleSound() {
    const next = toggleSound();
    setSoundOn(next);
  }

  const pusherRef = useRef<PusherClient | null>(null);
  const chatChannelRef = useRef<PusherChannel | null>(null);
  const fromPusherRef = useRef(false);

  useEffect(() => {
    getState().then(data => setSt(data)).catch(() => {});
  }, []);

  // 🔄 مزامنة لحظية بين الأدمن والمساعد: أي تغيير يسويه أي واحد منهم (بأي
  // تبويب/جهاز) ينوصل فوراً للطرف الثاني عن طريق نفس قناة الـ SSE اللي
  // تستخدمها صفحة العرض المباشر. بدون هذا، كل واحد يشوف نسخة قديمة من
  // الحالة إلى أن يعمل تحديث يدوي للصفحة.
  const typingRef = useRef(false); // true أثناء ما الأدمن يكتب بخانة اسم لاعب (عشان ما نلخبط عليه وهو يكتب)
  useSSE((data) => {
    if (typingRef.current) return; // ما نطبّق تحديث خارجي وهو يكتب حالياً
    setSt(data);
    // 🔄 قائمة نظام المستويات مبنية على سجل الفائزين — نحدّثها مع كل بث
    // عشان الفائز الجديد يظهر فوراً بعد إقفال البطولة بدون رفرش.
    refreshLvlWinnersRef.current?.();
  });

  const sync = useCallback(async (newSt: TournamentState) => {
    console.log("[Admin] Syncing state, phase:", newSt.phase, "players:", newSt.players.length);
    try {
      await postState(newSt, token);
      setSyncError("");
    } catch (err) {
      console.error("[Admin] Sync failed:", err);
      setSyncError("فشل حفظ الحالة");
    }
  }, [token]);

  useEffect(() => {
    if (fromPusherRef.current) {
      fromPusherRef.current = false;
      sync(st);
    }
  }, [st, sync]);

  const update = useCallback((newSt: TournamentState) => {
    console.log("[Admin] update() phase:", newSt.phase, "players:", newSt.players.length);
    setSt(newSt);
    sync(newSt);
  }, [sync]);

  useEffect(() => {
    connectToKickChat();
    return () => {
      if (chatChannelRef.current && pusherRef.current) {
        chatChannelRef.current.unbind_all();
        pusherRef.current.unsubscribe(chatChannelRef.current.name);
      }
    };
  }, [CH]);

  function connectToKickChat() {
    setChatStatus("connecting");
    if (chatChannelRef.current) {
      chatChannelRef.current.unbind_all();
      if (pusherRef.current) pusherRef.current.unsubscribe(chatChannelRef.current.name);
      chatChannelRef.current = null;
    }
    const meta = CHANNEL_META[CH];
    if (!meta) { setChatStatus("offline"); return; }
    try {
      if (!pusherRef.current) {
        pusherRef.current = new PusherLib("32cbd69e4b950bf97679", { cluster: "us2", forceTLS: true });
      }
      const pusher = pusherRef.current!;
      const channel = pusher.subscribe(`chatrooms.${meta.chatroomId}.v2`);
      chatChannelRef.current = channel;
      channel.bind("pusher:subscription_succeeded", () => setChatStatus("live"));
      channel.bind("pusher:subscription_error", () => setChatStatus("offline"));
      pusher.connection.bind("state_change", (states: any) => {
        if (states.current === "connected") setChatStatus("live");
        if (states.current === "failed" || states.current === "disconnected") setChatStatus("offline");
      });
      const handleChatMessage = (rawData: unknown) => {
        const payload = typeof rawData === "string" ? safeJsonParse(rawData) : rawData;
        const normalized = getNestedPayload(payload) as Record<string, unknown>;
        const content = normalizeText(
          (normalized?.content as unknown) ?? (normalized?.message as unknown) ?? (normalized?.text as unknown) ?? ""
        );
        const sender = (normalized?.sender as Record<string, unknown> | undefined) ??
          (normalized?.user as Record<string, unknown> | undefined) ?? (normalized as Record<string, unknown>);
        const user = normalizeText(
          (sender?.username as unknown) ?? (sender?.name as unknown) ?? (normalized?.username as unknown) ?? ""
        );
        if (!content || !user) return;

        // 🚪 أمر الانسحاب الذاتي: يخلي اللاعب يطلع نفسه من القائمة قبل بدء البطولة.
        // يُقبل بعلامة ! أو بدونها (خروج / !خروج / leave / !leave).
        if (LEAVE_CMD.test(content)) {
          let didLeave = false;
          setSt(prev => {
            if (prev.phase !== "setup") return prev;
            if (!isUserAlreadyJoined(prev.players, user)) return prev;
            fromPusherRef.current = true;
            didLeave = true;
            return removeEntryFromState(prev, user);
          });
          if (didLeave) { /* لا داعي لجلب صورة، بس نسحب */ }
          return;
        }

        if (!JOIN_CMD.test(content)) return;

        let didAdd = false;
        setSt(prev => {
          if (prev.phase !== "setup") return prev;
          // 🚪 باب الانضمام مقفل افتراضياً: ما نقبل ولا !دخول إلا إذا الأدمن أو
          // المساعد ضغط زر "افتح باب الانضمام" فعلاً (joinDeadline محدد) وما
          // انتهت مهلته بعد. قبل هذا التعديل كان أي !دخول يُقبل طول الوقت لو
          // ما فيه joinDeadline أصلاً، وهذا كان يخالف المطلوب.
          if (!prev.joinDeadline || Date.now() > prev.joinDeadline) return prev;
          if (isUserAlreadyJoined(prev.players, user)) return prev;
          fromPusherRef.current = true;
          didAdd = true;
          return addEntryToState(prev, user);
        });
        if (didAdd) enrichEntryAvatar(user);
      };
      channel.bind("App\\Events\\ChatMessageEvent", handleChatMessage);
      channel.bind("ChatMessageEvent", handleChatMessage);
      channel.bind("App\\Events\\ChatMessageEventV2", handleChatMessage);
      pusher.connection.bind("error", () => setChatStatus("offline"));
    } catch (err) {
      setChatStatus("offline");
    }
  }

  // ✅ توحيد اسم المستخدم (يشيل الفراغات الزايدة ويطبّع الأحرف) عشان مقارنة الأسماء
  // تكون دقيقة 100% بدل الاعتماد على substring اللي كان يفشل أحياناً ويسمح
  // لنفس الشخص يدخل أكثر من مرة (خصوصاً لو فيه فراغات أو رموز غير مرئية بالاسم).
  function normalizeUsername(u: string): string {
    return (u || "").normalize("NFKC").trim().toLowerCase();
  }

  // ✅ يتحقق هل المستخدم موجود فعلاً بقائمة اللاعبين (يدعم وضع الفرق حيث كل خانة
  // فيها أكثر من اسم مفصولين بـ " N ") — مقارنة دقيقة (exact match) وليس substring.
  function isUserAlreadyJoined(players: string[], user: string): boolean {
    const target = normalizeUsername(user);
    if (!target) return false;
    return players.some((p) => {
      if (!p) return false;
      return p.split(" N ").some((m) => normalizeUsername(m) === target);
    });
  }

  function safeJsonParse(value: string) {
    try { return JSON.parse(value); } catch { return value; }
  }

  function getNestedPayload(value: unknown) {
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    if (typeof record.data === "string") return getNestedPayload(safeJsonParse(record.data));
    if (record.data && typeof record.data === "object") return getNestedPayload(record.data);
    return record;
  }

  function normalizeText(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
  }

  // ✅ إضافة لاعب — يملأ أول خانة فاضية ضمن الحجم المحدد
  // 🚪 يشيل لاعب معيّن بناءً على أمر !خروج — لو بفريق يشيله من فريقه فقط
  // (ويشيل الفريق كامل لو صار فاضي بعدها)، ولو فردي يفضي خانته بالكامل.
  function removeEntryFromState(prev: TournamentState, user: string): TournamentState {
    const target = normalizeUsername(user);
    const players = prev.players
      .map((p) => {
        if (!p) return p;
        const members = p.split(" N ").filter((m) => normalizeUsername(m) !== target);
        return members.join(" N ");
      })
      .filter((p) => p);
    const entryLog = prev.entryLog.filter((e) => normalizeUsername(e.user) !== target);
    const size = Math.max(players.length, 2);
    const bSize = p2(size);
    const byeN = bSize - size;
    return { ...prev, players, size, bSize, byeN, entryLog };
  }

  function addEntryToState(prev: TournamentState, user: string): TournamentState {
    const now = new Date();
    const timeStr = `${now.getHours()}:${now.getMinutes().toString().padStart(2, "0")}`;
    const entry: EntryLogItem = { user, time: timeStr };
    let players = [...prev.players];
    let size = prev.size;
    let added = false;

    if (prev.isTeams) {
      for (let i = 0; i < size; i++) {
        const current = players[i] || "";
        const members = current ? current.split(" N ") : [];
        if (members.length < prev.teamSize) {
          members.push(user);
          players[i] = members.join(" N ");
          added = true;
          break;
        }
      }
      if (!added) { players.push(user); size = players.length; added = true; }
    } else {
      let inserted = false;
      for (let i = 0; i < size; i++) {
        if (!players[i]) { players[i] = user; inserted = true; added = true; break; }
      }
      if (!inserted) { players.push(user); size = players.length; added = true; }
    }

    if (!added) return prev;

    const bSize = p2(size);
    const byeN = bSize - size;
    return { ...prev, players, size, bSize, byeN, entryLog: [...prev.entryLog, entry] };
  }

  function handleEntry(user: string, currentSt: TournamentState, updater: typeof update) {
    if (currentSt.phase !== "setup") return;
    if (isUserAlreadyJoined(currentSt.players, user)) return;
    const newSt = addEntryToState(currentSt, user);
    updater(newSt);
    enrichEntryAvatar(user);
  }

  // 🖼️ توليد رابط صورة احتياطية (Fallback) بألوان الموقع (أخضر كيك + أزرق) في حال تعذّر جلب صورة كيك الحقيقية
  function fallbackAvatar(user: string): string {
    return `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(user)}&backgroundType=gradientLinear&backgroundColor=53fc18,29b6f6&textColor=060d1a&fontWeight=800`;
  }

  // 🖼️ محاولة جلب صورة بروفايل اللاعب الحقيقية من كيك، ثم تحديث entryLog بها بمجرد توفرها
  // (بدون إعاقة إضافة اللاعب — الإضافة تتم فورًا، والصورة تُلحق لاحقًا فور وصولها)
  async function enrichEntryAvatar(user: string) {
    let avatar: string | null = null;
    try {
      const r = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(user)}`, { headers: { Accept: "application/json" } });
      if (r.ok) {
        const d = await r.json();
        avatar = d?.user?.profile_pic || null;
      }
    } catch {
      avatar = null;
    }
    if (!avatar) avatar = fallbackAvatar(user);
    setSt(prev => ({
      ...prev,
      entryLog: prev.entryLog.map(e => (e.user === user && !e.avatar ? { ...e, avatar } : e)),
    }));
  }

  async function kickCheck(manual = false) {
    if (!manual) setKLive(false);
    try {
      const r = await fetch(`https://kick.com/api/v2/channels/${CH}`, { headers: { Accept: "application/json" } });
      if (!r.ok) throw 0;
      const d = await r.json();
      const live = d?.livestream != null;
      setKLive(live);
    } catch {
      setKLive(true);
    }
  }

  useEffect(() => {
    kickCheck(true);
    const id = setInterval(() => kickCheck(), 90000);
    return () => clearInterval(id);
  }, [CH]);

  // 🔁 تبديل نظام الفرق (تشغيل/إلغاء) — الإصلاح: لما نلغي "الفرق" بعد ما كان
  // فيه لاعبين مجمّعين مع بعض بنفس الخانة (مثلاً "أحمد N هشام")، لازم نفرّط
  // كل خانة لخانات فردية عشان اللاعبين ما يضلوش عالقين مع بعض. قبل الإصلاح
  // كان بس يبدّل isTeams بدون ما يلمس players، فتضل الأسماء ملتصقة ببعضها.
  function toggleTeams(checked: boolean) {
    if (!checked) {
      // 🔻 إلغاء الفرق: نفرّط كل خانة (قد تحتوي أكثر من اسم مفصول بـ " N ")
      // إلى خانات فردية منفصلة.
      const allMembers = st.players.flatMap((p) => (p ? p.split(" N ") : []));
      const size = Math.max(allMembers.length, 2);
      const bSize = p2(size);
      const byeN = bSize - size;
      update({ ...st, isTeams: false, players: allMembers, size, bSize, byeN });
    } else {
      // 🔺 تفعيل الفرق: كان الباق قبل هذا الإصلاح يكتفي بتبديل isTeams فقط
      // بدون ما يجمّع اللاعبين الحاليين (المنضمين كأفراد) بفرق فعلية — فتظل
      // كل خانة فيها لاعب واحد بس حتى لو فعّلت "نظام الفرق". دابا نجمّع كل
      // اللاعبين الحاليين مباشرة بفرق بحجم teamSize.
      const allMembers = st.players.flatMap((p) => (p ? p.split(" N ") : []));
      const teamSize = Math.max(1, st.teamSize);
      const newPlayers: string[] = [];
      for (let i = 0; i < allMembers.length; i += teamSize) {
        newPlayers.push(allMembers.slice(i, i + teamSize).join(" N "));
      }
      const size = Math.max(newPlayers.length, 2);
      const bSize = p2(size);
      const byeN = bSize - size;
      update({ ...st, isTeams: true, players: newPlayers, size, bSize, byeN });
    }
  }

  function handleSizeChange(n: number) {
    const newSt = stSetSize(st, n);
    update(newSt);
  }

  // 🎲 يفرّط كل اللاعبين المنضمين حاليًا من فرقهم، ويرجّع يوزّعهم بفرق عشوائية
  // جديدة بنفس حجم الفريق (teamSize) — مفيد لما تحب تعيد تشكيل الفرق بعد ما
  // ينضم الكل بدل ما يضلوا مرتبين حسب ترتيب انضمامهم بالشات.
  function shuffleTeams() {
    if (!st.isTeams) return;
    const allMembers = st.players.flatMap(p => (p ? p.split(" N ") : []));
    if (allMembers.length < 2) {
      alert("⚠️ ما فيه لاعبين كفاية لعمل ترتيب عشوائي — لازم ينضم لاعبين اثنين على الأقل.");
      return;
    }
    const shuffled = [...allMembers];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const teamSize = Math.max(1, st.teamSize);
    const newPlayers: string[] = [];
    for (let i = 0; i < shuffled.length; i += teamSize) {
      newPlayers.push(shuffled.slice(i, i + teamSize).join(" N "));
    }
    const size = Math.max(newPlayers.length, 2);
    const bSize = p2(size);
    const byeN = bSize - size;
    update({ ...st, players: newPlayers, size, bSize, byeN });
  }

  // ⏱️ يفتح باب الانضمام لمدة محددة بالدقائق — بعد ما تنتهي المهلة، أي !دخول جديد يتجاهله
  // الكود تلقائيًا (الشيك موجود بـ handleChatMessage)
  function openJoinWindow(durationMinutes: number) {
    const deadline = Date.now() + Math.max(1, durationMinutes) * 60 * 1000;
    update({ ...st, joinDeadline: deadline });
  }

  function cancelJoinWindow() {
    update({ ...st, joinDeadline: null });
  }

  function getJoinSecondsLeft(): number {
    if (!st.joinDeadline) return 0;
    return Math.max(0, Math.ceil((st.joinDeadline - Date.now()) / 1000));
  }

  // 🚪 طرد لاعب واحد بعينه من خانته (تدعم وضع الفرق حيث كل خانة فيها أكثر من
  // اسم مفصولين بـ " N "). لو كانت الخانة فردية أو صارت فاضية بعد الطرد،
  // الخانة كاملة تُحذف. تُستدعى من زر ✕ اللي يظهر عند التأشير (hover) على
  // كارت اللاعب.
  function removeMemberFromSlot(slotIdx: number, memberIdx: number) {
    const current = st.players[slotIdx];
    if (!current) return;
    const members = current.split(" N ").filter(Boolean);
    const removedMember = members[memberIdx];
    members.splice(memberIdx, 1);

    const players = [...st.players];
    if (members.length === 0) {
      players.splice(slotIdx, 1);
    } else {
      players[slotIdx] = members.join(" N ");
    }
    const size = Math.max(2, players.length);
    const bSize = p2(size);
    const byeN = bSize - size;

    // ✅ نشيل اللاعب المطرود من entryLog كمان، عشان يختفي فوراً من صفحة
    // البث المباشر (/live) وليس فقط من قائمة الأدمن.
    const entryLog = removedMember
      ? st.entryLog.filter((e) => normalizeUsername(e.user) !== normalizeUsername(removedMember))
      : st.entryLog;
    update({ ...st, players, size, bSize, byeN, entryLog });
  }

  // 🧠 يتحقق هل عدد اللاعبين الحقيقيين (المنضمين فعلاً) كافي للبدء — بيرجع
  // null لو كل شي تمام، أو رسالة واضحة توضح بالضبط كم لاعب ناقص.
  function getStartBlockReason(): string | null {
    const joined = st.players.filter(p => p).length;
    const MIN_PLAYERS = 2;
    if (joined === 0) {
      return "⚠️ ما انضم ولا لاعب لسا! خلي المشاهدين يكتبوا دخول بالشات قبل ما تبدأ.";
    }
    if (joined < MIN_PLAYERS) {
      const missing = MIN_PLAYERS - joined;
      return `⚠️ اللاعبين غير كافيين! عندك ${joined} لاعب بس، ناقصك ${missing} لاعب على الأقل عشان تقدر تبدأ البطولة.`;
    }
    return null;
  }

  // ✅ بدء البطولة — يعمل مع أي عدد من اللاعبين (يحسب أقرب قوة لـ 2)
  function startTournament() {
    const blockReason = getStartBlockReason();
    if (blockReason) {
      // البانر الاحترافي تحت الزر بيوضّح السبب لحظيًا — ما في داعي لـ alert مزعج
      return;
    }
    const label = st.isTeams ? "فريق" : "لاعب";

    // العدد يُحسب تلقائياً بناءً على من انضم فعلاً من الشات
    const joined = st.players.filter(p => p).length;
    const size = Math.max(joined, 2);
    const bSize = p2(size);
    const byeN = bSize - size;

    const players = Array.from({ length: size }, (_, i) => st.players[i] || `${label} ${i + 1}`);
    const name = st.name;
    const base = { 
      ...st, 
      players, 
      size,
      bSize,
      byeN,
      name, 
      phase: "tournament" as const, 
      champion: "", 
      winHistory: [], 
      pickedMatchId: null,
      cur: 0,
    };
    console.log("[Admin] Starting tournament with", players.length, "players");
    const newSt = buildBracket(base);
    console.log("[Admin] Bracket built, rounds:", newSt.rounds?.length);
    update(newSt);
    playStart();
    setSlotA("—"); setSlotB("—");
    setSlotStateA("idle"); setSlotStateB("idle");
  }

  // 🪄 كرت تلقائي: لما تنتهي البطولة، بدل ما الأدمن يروح لقسم "سجل البطولات" ويكتب
  // اسم اللعبة واسم الفائز يدوياً، هذا الزر يسوي كل شي لحاله — ياخذ اسم اللعبة/البطولة
  // واسم البطل من حالة البطولة الحالية، ويولّد صورة البراكيت، ويحفظهم كخانة جديدة
  // (أو يحدّث خانة موجودة بنفس الاسم) — بدون ما يحتاج يكتب أي شي.
  const [autoCardBusy, setAutoCardBusy] = useState(false);
  const [autoCardStatus, setAutoCardStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  // ── 🏆 اعتماد الفائز بكرت موجود ثم إقفال البطولة تلقائياً ──
  const [cardPickOpen, setCardPickOpen] = useState(false);
  const [cardPickBusy, setCardPickBusy] = useState(false);

  async function assignWinnerToCard(rec: TournamentRecord) {
    const champion = (st.champion || "").trim();
    if (!champion || cardPickBusy) return;
    setCardPickBusy(true);
    setAutoCardStatus(null);
    try {
      // putRecord يحدّث الكرت الموجود بنفس الاسم — نحافظ على صوره واسم العرض
      await putRecord({
        tournamentName: rec.tournamentName,
        displayName: rec.displayName || undefined,
        winnerName: champion,
        image: rec.image || "",
        image2: rec.image2 || undefined,
      }, token);
      refreshRecords();
      setCardPickOpen(false);
      // 🔒 تُقفل البطولة تلقائياً بعد الاختيار (بدون سؤال تأكيد)
      resetTournament(true);
    } catch (e: any) {
      setAutoCardStatus({ ok: false, msg: e?.message || "⚠️ تعذّر حفظ الفائز بالكرت" });
    } finally {
      setCardPickBusy(false);
    }
  }

  async function autoCreateWinnerCard() {
    setAutoCardStatus(null);
    const champion = (st.champion || "").trim();
    if (!champion) return;
    // 🐛 قبل: كان يفضّل st.gameType/lastGameType على اسم البطولة الحقيقي.
    // gameType ما عنده أي حقل بالواجهة يخليك تعدّله، فيضل يحمل قيمة قديمة
    // عالقة من بطولة قديمة (مثلاً "Rocket League") حتى لو دابا سميت البطولة
    // "ستمبل" — فيطلع الكرت باسم لعبة غلط. اسم البطولة (st.name) اللي أنت
    // كاتبه فعلاً بخانة "اسم البطولة" هو المصدر الصحيح والأولوية له دايماً.
    const game = (st.name || st.gameType || st.lastGameType || "بطولة عامة").trim();
    setAutoCardBusy(true);
    try {
      const rounds = st.rounds || [];
      const bracketChampion = rounds.length ? (rounds[rounds.length - 1][0]?.winner || "") : "";
      const realChampion = (bracketChampion && bracketChampion !== BYE) ? bracketChampion : champion;
      const image = generateBracketImage(realChampion) || "";
      await putRecord({ tournamentName: game, winnerName: realChampion, image }, token);
      refreshRecords();
      setAutoCardStatus({ ok: true, msg: `✅ تم إنشاء الكرت "${game}" بالفائز "${realChampion}" — شوفه بقسم "سجل البطولات"` });
    } catch (e: any) {
      setAutoCardStatus({ ok: false, msg: e?.message || "⚠️ تعذّر إنشاء الكرت تلقائياً" });
    } finally {
      setAutoCardBusy(false);
    }
  }

  // skipConfirm: يُستخدم عند الإقفال التلقائي بعد اعتماد الفائز بكرت
  function resetTournament(skipConfirm = false) {
    if (!skipConfirm && !confirm("تبدأ بطولة جديدة؟ بيتمسح كل شي")) return;
    const champion = st.champion || st.lastWinner;
    const wasFinished = champion && st.rounds.length;
    const finishState = (archiveId?: number) => {
      // 🏆 نسجّل الفائز بسجل winnerHistory (نفس المصفوفة التي تغذّي كروت
      // الثيمات/التخصيص بشريط الفائزين) — قبل كذا كانت تُبنى بس ما حد يعبّيها.
      const newWinnerEntry = wasFinished
        ? [{
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: champion,
            // 🐛 نفس المشكلة: st.gameType يضل عالق بقيمة قديمة (مثلاً "Rocket
            // League") لأنه ما عنده خانة بالواجهة يتعدّل منها، فكان يطلع دايماً
            // بدل اسم البطولة الحقيقي إللي الأدمن كاتبه فعلاً بخانة "اسم البطولة".
            gameType: st.name || st.gameType || st.lastGameType || "بطولة عامة",
            tournamentName: st.name || st.lastTournamentName || "IK3MO",
            date: new Date().toISOString(),
            archiveId,
          }]
        : [];
      const newSt = {
        ...defaultState(),
        lastWinner: champion || st.lastWinner,
        // 🐛 قبل: `gameType: st.gameType` كان يحمّل القيمة القديمة العالقة
        // للبطولة الجاية بعدها كمان، فتضل تتكرر للأبد بكل بطولة جديدة حتى لو
        // غيّرت الاسم. دابا نصفّرها ونخلي lastGameType يحفظ اسم آخر بطولة
        // (المبني على الاسم الحقيقي) بس ما نمررهاش كـ gameType نشطة.
        lastGameType: st.name || st.gameType || st.lastGameType,
        lastTournamentName: st.name || st.lastTournamentName,
        gameType: "",
        name: st.name,
        pickedMatchId: null,
        winnerHistory: [...newWinnerEntry, ...st.winnerHistory],
      };
      update(newSt);
      setSlotA("—"); setSlotB("—");
      setSlotStateA("idle"); setSlotStateB("idle");
    };
    if (wasFinished) {
      postArchive({
        name: st.name || st.lastTournamentName || "IK3MO",
        gameType: st.name || st.gameType || st.lastGameType || "بطولة عامة",
        champion,
        isTeams: st.isTeams,
        teamSize: st.teamSize,
        players: st.players,
        rounds: st.rounds,
        finishedAt: new Date().toISOString(),
      }, token).then((archive) => finishState(archive?.id));
    } else {
      finishState();
    }
  }

  function handleWin(rIdx: number, mIdx: number, side: "a" | "b") {
    const wasPicked = st.pickedMatchId === `${rIdx}-${mIdx}`;
    if (wasPicked) { setSlotA("—"); setSlotB("—"); setSlotStateA("idle"); setSlotStateB("idle"); }

    // 🏆 نقطة توب الفائزين: كل ماتش حقيقي تكسبه = نقطة، بأي جولة وأي بطولة.
    // نتجاهل الماتشات اللي خصمها "باي" لأن اللاعب عدّى بدون ما يلعب.
    // 🚫 وبوضع الفرق ما نحسب نقاط أصلاً: الخانة تحتوي فريق كامل مو لاعب
    //    واحد ("سعود N فهد")، فتسجيلها بقائمة الأكثر انتصاراً يخرّب القائمة
    //    بأسماء فرق بدل أسماء لاعبين.
    const m = st.rounds[rIdx]?.[mIdx];
    const matchWinner = side === "a" ? m?.a : m?.b;
    const matchLoser = side === "a" ? m?.b : m?.a;
    if (!st.isTeams && matchWinner && !isBotName(matchWinner) && matchWinner !== BYE && matchLoser && matchLoser !== BYE && !m?.isBye) {
      addMatchWin(matchWinner, 1, token);
    }

    let newSt = doWin(st, rIdx, mIdx, side);
    if (wasPicked) newSt = { ...newSt, pickedMatchId: null };
    const lastRound = newSt.rounds[newSt.rounds.length - 1];
    const isChampion = lastRound?.length === 1 && !!lastRound[0].winner && lastRound[0].winner !== BYE;
    if (isChampion) playChampion(); else playWin();
    const { winHistory: _drop, ...snapshot } = st;
    newSt.winHistory = [...(st.winHistory || []), snapshot as HistorySnapshot].slice(-15);
    update(newSt);
    // 🏆 اللفل يزيد تلقائيًا لحظة تتويج البطل — ما نحتاج الأدمن يزيد النقاط يدوياً
    if (isChampion) {
      autoAddWinForChampion(lastRound[0].winner!, st.name || st.gameType || st.lastGameType || "بطولة عامة");
    }
  }

  // ⬆️ يجلب فوزات البطل الحالية بهذي اللعبة ويزيدها بواحد تلقائياً (بدل التعديل
  // اليدوي +1/-1 اللي كان الأدمن يسويه بنفسه من "إحصائيات اللاعبين").
  async function autoAddWinForChampion(champion: string, game: string) {
    if (isBotName(champion)) return;   // 🤖 بوت تجربة — ما ينحسب بالمستويات
    try {
      const data = await getPlayerStats(champion);
      const current = data?.wins?.[game] ?? 0;
      await setPlayerWins(champion, game, current + 1, token);
      // لو الأدمن فاتح صفحة إحصائيات نفس اللاعب، نحدّثها لحظياً
      if (statsSearched && normalizeUsername(statsSearched) === normalizeUsername(champion)) {
        setStatsData(prev => prev ? { ...prev, wins: { ...prev.wins, [game]: current + 1 } } : prev);
      }
    } catch {
      // فشل صامت — ما نوقف تتويج البطل بسبب خطأ بتحديث الإحصائيات
    }
  }

  // يقارن شجرتين ويرجّع اسم الفائز بالماتش اللي انحسم بينهما (أو null لو
  // ما فيه فرق أو كان ماتش باي). يستعمله التراجع عشان يعرف مين يسحب نقطته.
  function findUndoneMatchWinner(cur: TournamentState, prev: TournamentState): string | null {
    const rounds = cur.rounds || [];
    const prevRounds = prev.rounds || [];
    for (let r = 0; r < rounds.length; r++) {
      for (let i = 0; i < rounds[r].length; i++) {
        const now = rounds[r][i];
        const before = prevRounds[r]?.[i];
        if (now?.winner && !before?.winner) {
          const loser = now.winner === now.a ? now.b : now.a;
          if (now.winner === BYE || !loser || loser === BYE || now.isBye) return null;
          return now.winner;
        }
      }
    }
    return null;
  }

  function undoLastWin() {
    if (!st.winHistory || !st.winHistory.length) return;
    if (!confirm("تراجع عن آخر نتيجة فوز؟")) return;
    const remaining = [...st.winHistory];
    const prevSnapshot = remaining.pop()!;

    // 🔙 نسحب نقطة الماتش اللي تراجعنا عنه: نقارن الشجرة الحالية بالسابقة
    // ونلقى الماتش اللي كان محسوم وصار غير محسوم.
    const undoneWinner = findUndoneMatchWinner(st, prevSnapshot as TournamentState);
    // بوضع الفرق ما سجّلنا نقطة أصلاً، فما فيه شي نسحبه
    if (undoneWinner && !st.isTeams && !isBotName(undoneWinner)) addMatchWin(undoneWinner, -1, token);

    const restored: TournamentState = { ...prevSnapshot, winHistory: remaining, pickedMatchId: null };
    setSlotA("—"); setSlotB("—");
    setSlotStateA("idle"); setSlotStateB("idle");
    update(restored);
  }

  // 🎲 اختيار ماتش عشوائي — بدون أي تنقلات ولا سلوت: ضغطة وحدة تختار
  // المتنافسين فوراً، تشغّل صوت بدء الماتش، وتحط ستروك أحمر حول الخانة
  // بالشجرة عشان الكل يعرف مين ضد مين الحين.
  // 🤖 إضافة بوتات للتجربة — يعبّي خانات بأسماء وهمية عشان تجرّب الشجرة
  // وتختبر الشكل بدون ما تنتظر ناس ينضمون من الشات. بوضع الفرق يضيف فريق
  // كامل بعدد اللاعبين المحدد. زر "🧹 تفريغ" يشيلهم كلهم.
  function addBots(count: number) {
    const slots = [...st.players];
    const taken = new Set(st.players.filter(Boolean).flatMap(p => p.split(" N ")));
    let n = 1;
    const nextName = () => {
      let nm = `بوت ${n++}`;
      while (taken.has(nm)) nm = `بوت ${n++}`;
      taken.add(nm);
      return nm;
    };
    for (let i = 0; i < count; i++) {
      slots.push(
        st.isTeams
          ? Array.from({ length: Math.max(1, st.teamSize) }, nextName).join(" N ")
          : nextName()
      );
    }
    // نحدّث نفس الحقول اللي يحدّثها الانضمام من الشات عشان الحالة تضل متسقة
    const size = slots.length;
    const bSize = p2(size);
    update({ ...st, players: slots, size, bSize, byeN: bSize - size });
  }

  function pickRandomMatch() {
    if (pickRunning) return;
    const open = getOpenMatches(st);
    if (!open.length) { setSlotA("لا يوجد ماتشات"); setSlotB("—"); return; }
    setPickRunning(true);
    const chosen = open[Math.floor(Math.random() * open.length)];
    setSlotA(chosen.m.a!);
    setSlotB(chosen.m.b!);
    setSlotStateA("locked");
    setSlotStateB("locked");
    playMatchStart();
    update({ ...st, pickedMatchId: `${st.cur}-${chosen.i}` });
    setPickRunning(false);
  }

  const titleText = "iK3MO";
  const label = st.isTeams ? "فريق" : "لاعب";
  const slotClassA = `pick-slot${slotStateA === "rolling" ? " rolling" : slotStateA === "locked" ? " locked-in" : ""}`;
  const slotClassB = `pick-slot${slotStateB === "rolling" ? " rolling" : slotStateB === "locked" ? " locked-in" : ""}`;

  return (
    <>
      <style>{`
        /* ── تجاوب عام مع الجوال ── */
        .shell {
          display: flex;
          width: 100%;
          min-height: 100vh;
        }
        .main {
          flex: 1;
          min-width: 0;
          padding: 16px;
          box-sizing: border-box;
        }
        @media (max-width: 900px) {
          .shell {
            flex-direction: column;
          }
          .main {
            padding: 10px;
          }
        }
        .card {
          padding: 16px;
          box-sizing: border-box;
        }
        @media (max-width: 640px) {
          .card {
            padding: 12px;
            border-radius: 12px;
          }
          h1 {
            font-size: 1.5rem !important;
          }
          .site-header p {
            font-size: 0.82rem;
          }
        }

        /* ── كارت انتظار انضمام اللاعبين ── */
        @keyframes ik3mo-pulse {
          0%, 100% { opacity: 0.5; transform: scale(1); }
          50% { opacity: 1; transform: scale(1.1); }
        }
        @media (max-width: 480px) {
        }

        /* ── شبكة اللاعبين/الفرق ── */
        .ik3mo-names-grid {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
        }
        .ik3mo-team-slot {
          display: flex;
          align-items: center;
          gap: 6px;
          flex-wrap: wrap;
        }
        .ik3mo-members {
          display: flex;
          align-items: center;
          gap: 6px;
          flex-wrap: wrap;
        }
        .ik3mo-chip-wrap {
          display: inline-flex;
          align-items: center;
        }
        .ik3mo-chip {
          display: inline-flex;
          align-items: center;
          padding: 7px 12px;
          border-radius: 10px;
          background: rgba(255,255,255,0.06);
          border: 1px solid var(--border, rgba(255,255,255,0.14));
          font-size: 0.85rem;
          font-weight: 700;
          color: #fff;
          transition: border-color .15s ease, background .15s ease;
        }
        .ik3mo-chip-wrap:hover .ik3mo-chip,
        .ik3mo-chip-wrap:focus-within .ik3mo-chip {
          border-color: rgba(248,113,113,0.55);
          background: rgba(248,113,113,0.1);
        }
        /* 🔤 الاسم يظهر كامل — يلتف على أكثر من سطر بدل ما يتقصّ بنقاط */
        .ik3mo-chip-text {
          white-space: normal;
          overflow-wrap: anywhere;
          word-break: break-word;
          max-width: 260px;
          line-height: 1.35;
        }
        .ik3mo-chip-x {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 0;
          height: 16px;
          opacity: 0;
          overflow: hidden;
          margin-inline-start: 0;
          border: none;
          background: transparent;
          color: #f87171;
          font-size: 0.72rem;
          font-weight: 900;
          cursor: pointer;
          padding: 0;
          flex-shrink: 0;
          transition: width .15s ease, opacity .15s ease, margin .15s ease;
        }
        .ik3mo-chip-wrap:hover .ik3mo-chip-x,
        .ik3mo-chip-wrap:focus-within .ik3mo-chip-x {
          width: 16px;
          opacity: 1;
          margin-inline-start: 6px;
        }
        /* على الجوال ما فيه hover — نخلي الـ X ظاهر دايماً بشفافية خفيفة عشان يقدر يطرد بالنقر */
        @media (hover: none) {
          .ik3mo-chip-x {
            width: 16px !important;
            opacity: 0.65 !important;
            margin-inline-start: 6px !important;
          }
        }
        .ik3mo-amp {
          font-weight: 900;
          color: var(--blue, #29b6f6);
          font-size: 0.9rem;
          flex-shrink: 0;
        }
        @media (max-width: 640px) {
          .ik3mo-chip-text {
            max-width: 50vw;
          }
        }

        /* ── الشريط الجانبي على الجوال ── */
        @media (max-width: 900px) {
        }
      `}</style>
      <div id="bg" style={{ backgroundImage: `url(${bgImg})` }} />
      <div id="bg-grad" />

      <div className="shell admin-shell">
        <div className="main">
          <div style={{ width: "100%", margin: "0 auto" }}>
            <header className="site-header" style={{ position: "relative" }}>
              {/* 🎛️ أزرار اللوحة — كانت متفرقة بالسايدبار، جمعناها هنا برأس
                  الصفحة عشان تكون واضحة وبمتناول اليد دايماً. */}
              <div className="admin-actions">
                <button className="admin-act" onClick={handleToggleSound} title={soundOn ? "كتم الصوت" : "تشغيل الصوت"}>
                  {soundOn ? "🔊 الصوت" : "🔇 مكتوم"}
                </button>
                <button
                  className={`admin-act${chatStatus === "live" ? " on" : ""}`}
                  onClick={() => kickCheck(true)}
                  title="يعيد التحقق من بث Kick ويحدّث اتصال الشات"
                >
                  🔄 تحقق الآن
                  <span className={`act-dot${chatStatus === "live" ? " live" : ""}`} />
                </button>
                {role === "admin" && (
                  <button className="admin-act" onClick={() => setHelpersOpen(true)} title="إنشاء مساعدين وتحديد صلاحياتهم">
                    🙋 المساعدين
                  </button>
                )}
                {/* 🏆 ينقلك للصفحة الرئيسية (لوحة الأبطال). رابط عادي عشان
                    الجلسة محفوظة بـ localStorage فترجع للأدمن بدون تسجيل. */}
                <a className="admin-act" href="/" title="الانتقال للوحة الأبطال (الصفحة الرئيسية)">
                  🏆 لوحة الأبطال
                </a>
                <button className="admin-act danger" onClick={onLogout} title="تسجيل الخروج من لوحة الأدمن">
                  🚪 خروج
                </button>
              </div>
              <div className="tag">IK3MO</div>
              <h1>{titleText}</h1>
              <p>اختر عدد اللاعبين، اكتب أسمائهم، وكل جولة اضغط على الفائز ليتأهل</p>
            </header>

            {syncError && (
              <div style={{ textAlign: "center", color: "#ff4444", marginBottom: "12px", fontSize: "0.85rem" }}>
                ⚠️ {syncError}
              </div>
            )}

            {/* 📊 شريط حالة مساحات التخزين (قاعدة البيانات + Cloudinary) */}
            {storageStatus && (
              <div style={{
                display: "flex", flexWrap: "wrap", justifyContent: "center", gap: "10px",
                marginBottom: "12px", fontSize: "0.78rem",
              }}>
                {([
                  { label: "قاعدة البيانات", s: storageStatus.database },
                  { label: "الصور (Cloudinary)", s: storageStatus.cloudinary },
                ] as const).map(({ label, s }) => (
                  <div key={label} style={{
                    display: "flex", alignItems: "center", gap: "6px", padding: "4px 10px",
                    borderRadius: "999px", background: "rgba(255,255,255,0.06)",
                    border: `1px solid ${s.ok ? "rgba(80,220,120,0.35)" : "rgba(255,68,68,0.4)"}`,
                  }}>
                    <span>{s.ok ? "🟢" : "🔴"}</span>
                    <span style={{ color: "var(--muted)" }}>{label}:</span>
                    <span style={{ fontWeight: 700 }}>
                      {s.ok
                        ? (s.usedPercent !== null ? `${s.usedPercent}% مستخدم` : "شغالة")
                        : (s.configured === false ? "غير مفعّلة" : "متوقفة")}
                      {/* نعرض سبب التوقف الحقيقي لو رجّعه الخادم */}
                      {(s as any).error && s.ok === false && (
                        <span style={{ display: "block", fontSize: "0.72rem", color: "#ff8b8b", fontWeight: 700, marginTop: "2px" }}>
                          ⚠️ {(s as any).error}
                        </span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {role === "admin" && (
              <div style={{ textAlign: "center", marginBottom: "12px" }}>
                <button
                  className="btn btn-ghost"
                  style={{ fontSize: "0.75rem", padding: "5px 12px" }}
                  disabled={migrating}
                  onClick={handleMigrateImages}
                  title="ينقل أي صور قديمة مخزّنة Base64 بقاعدة البيانات إلى Cloudinary"
                >
                  {migrating ? "⏳ جاري نقل الصور القديمة..." : "🔁 نقل الصور القديمة لـ Cloudinary"}
                </button>
                {migrateResult && (
                  <div style={{ fontSize: "0.75rem", color: "var(--muted)", marginTop: "6px" }}>{migrateResult}</div>
                )}
              </div>
            )}

            {/* 🙋 إدارة المساعدين — صارت نافذة تُفتح من زر بالشريط العلوي
                بدل ما تاخذ بطاقة كاملة وتزحم الصفحة. */}
            {role === "admin" && helpersOpen && (
              <div className="cardpick-overlay" onClick={() => setHelpersOpen(false)}>
                <div className="cardpick helpers-modal" onClick={e => e.stopPropagation()}>
                  <div className="cardpick-head">
                    <span>🙋 إدارة المساعدين</span>
                    <button className="cardpick-close" onClick={() => setHelpersOpen(false)} aria-label="إغلاق">✕</button>
                  </div>
                  <p className="cardpick-sub">أنشئ حساب مساعد وحدد له بالضبط وش يقدر يسوي.</p>

                <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px" }}>
                  <span style={{ fontSize: "1.15rem" }}>🙋</span>
                  <h3 style={{ fontSize: "1.05rem", fontWeight: 900 }}>إدارة المساعدين</h3>
                  <span style={{ fontSize: "0.75rem", color: "var(--muted)" }}>— أنشئ حساب مساعد وحدد له بالضبط وش يقدر يسوي</span>
                </div>

                {/* إنشاء مساعد جديد */}
                <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center", padding: "12px", borderRadius: "12px", background: "rgba(255,255,255,0.04)", border: "1px solid var(--border)" }}>
                  <input
                    type="text"
                    className="n-input"
                    style={{ flex: 1, minWidth: "160px" }}
                    placeholder="اسم المساعد (مثلاً: أخوي / مشرف الشات)"
                    value={helperName}
                    onChange={(e) => setHelperName(e.target.value)}
                    disabled={creatingHelper}
                  />
                  <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "0.82rem", cursor: "pointer" }}>
                    <input type="checkbox" checked={!!newHelperPerms.tournament} onChange={(e) => setNewHelperPerms((p) => ({ ...p, tournament: e.target.checked }))} />
                    🏆 إدارة البطولة
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "0.82rem", cursor: "pointer" }}>
                    <input type="checkbox" checked={!!newHelperPerms.records} onChange={(e) => setNewHelperPerms((p) => ({ ...p, records: e.target.checked }))} />
                    🗂️ سجل البطولات
                  </label>
                  <button
                    type="button"
                    className="btn btn-primary"
                    style={{ padding: "9px 16px", fontSize: "0.85rem", whiteSpace: "nowrap" }}
                    disabled={creatingHelper || !helperName.trim()}
                    onClick={handleCreateHelper}
                  >
                    {creatingHelper ? "..." : "➕ إنشاء مساعد"}
                  </button>
                </div>
                {helperError && <div style={{ color: "#ff4444", fontSize: "0.82rem", marginTop: "8px" }}>⚠️ {helperError}</div>}

                {/* الكود يظهر مرة وحدة بعد الإنشاء عشان الأدمن يرسله للمساعد */}
                {revealedCode && (
                  <div style={{ marginTop: "10px", padding: "12px", borderRadius: "12px", background: "rgba(83,252,24,0.08)", border: "1px solid rgba(83,252,24,0.3)", display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
                    <span style={{ fontSize: "0.85rem" }}>✅ تم إنشاء <b>{revealedCode.name}</b> — كود الدخول:</span>
                    <code style={{ fontWeight: 900, fontSize: "1.05rem", letterSpacing: "2px", color: "var(--kick,#53fc18)" }}>{revealedCode.code}</code>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      style={{ fontSize: "0.75rem", padding: "5px 10px" }}
                      onClick={() => { navigator.clipboard?.writeText(revealedCode.code); }}
                    >📋 نسخ</button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      style={{ fontSize: "0.75rem", padding: "5px 10px" }}
                      onClick={() => setRevealedCode(null)}
                    >✕ إخفاء</button>
                  </div>
                )}

                {/* قائمة المساعدين الحاليين */}
                <div style={{ marginTop: "16px", display: "flex", flexDirection: "column", gap: "10px" }}>
                  {helpers.length === 0 && (
                    <div style={{ fontSize: "0.85rem", color: "var(--muted)", textAlign: "center", padding: "10px 0" }}>
                      ما فيه مساعدين لسا.
                    </div>
                  )}
                  {helpers.map((h) => (
                    <div
                      key={h.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "14px",
                        flexWrap: "wrap",
                        padding: "10px 14px",
                        borderRadius: "12px",
                        background: "rgba(255,255,255,0.03)",
                        border: "1px solid var(--border)",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: "140px" }}>
                        <div style={{ width: "34px", height: "34px", borderRadius: "50%", background: "linear-gradient(135deg,#14b8a6,#0f172a)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 900 }}>
                          {h.name.charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <div style={{ fontWeight: 800, fontSize: "0.9rem" }}>{h.name}</div>
                          <div style={{ fontSize: "0.72rem", color: "var(--muted)", letterSpacing: "1px" }}>{h.code}</div>
                        </div>
                      </div>

                      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginRight: "auto" }}>
                        <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "0.78rem", cursor: "pointer" }}>
                          <input type="checkbox" style={{ width: "16px", height: "16px" }} checked={!!h.permissions?.tournament} onChange={() => handleToggleHelperPerm(h, "tournament")} />
                          🏆 البطولة
                        </label>
                        <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "0.78rem", cursor: "pointer" }}>
                          <input type="checkbox" style={{ width: "16px", height: "16px" }} checked={!!h.permissions?.records} onChange={() => handleToggleHelperPerm(h, "records")} />
                          🗂️ السجل
                        </label>
                      </div>

                      <button
                        type="button"
                        className="btn btn-ghost"
                        style={{ fontSize: "0.78rem", padding: "6px 10px", color: "#f87171", borderColor: "rgba(248,113,113,0.4)" }}
                        onClick={() => handleDeleteHelper(h)}
                        title="حذف المساعد نهائياً"
                      >🗑️ حذف</button>
                    </div>
                  ))}
                </div>
                </div>
              </div>
            )}


            {/* ── سجل البطولات: تعديل صورة كل لعبة (كروت ديناميكية يضيف/يحذف منها الأدمن) ── */}
            {!canRecords ? (
              <div className="card" style={{ textAlign: "center", padding: "28px 16px", opacity: 0.85 }}>
                <div style={{ fontSize: "1.6rem", marginBottom: "8px" }}>🔒</div>
                <div style={{ fontWeight: 800, marginBottom: "4px" }}>ما عندك صلاحية "سجل البطولات"</div>
                <div style={{ fontSize: "0.8rem", color: "var(--muted)" }}>اطلب من الأدمن الرئيسي يفعّلها لك من "إدارة المساعدين"</div>
              </div>
            ) : (
            <div className="card">
              <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
                <span style={{ fontSize: "1.15rem" }}>🏆</span>
                <h3 style={{ fontSize: "1.05rem", fontWeight: 900 }}>سجل البطولات</h3>
                <span style={{ fontSize: "0.75rem", color: "var(--muted)" }}>— عدّل اسم الفائز والصورة لكل لعبة، تظهر مباشرة للمشاهدين</span>
              </div>
              {recError && <div style={{ color: "#ff4444", fontSize: "0.82rem", margin: "8px 0" }}>⚠️ {recError}</div>}

              {/* إضافة كرت جديد */}
              <div style={{ display: "flex", gap: "8px", margin: "10px 0 4px", flexWrap: "wrap" }}>
                <input
                  type="text"
                  className="n-input"
                  style={{ flex: 1, minWidth: "180px", padding: "9px 12px" }}
                  placeholder="✏️ اسم اللعبة/الكرت الجديد"
                  value={newGameName}
                  disabled={savingGame !== null}
                  onChange={(e) => setNewGameName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleAddGame(); }}
                />
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ padding: "9px 16px", fontSize: "0.85rem", whiteSpace: "nowrap", opacity: savingGame !== null ? 0.55 : 1, cursor: savingGame !== null ? "not-allowed" : "pointer" }}
                  disabled={savingGame !== null}
                  onClick={handleAddGame}
                >➕ إضافة كرت</button>
                {/* 📜 سجل الصور — يفتح قائمة بكل صور الكروت وتواريخ رفعها */}
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ padding: "9px 16px", fontSize: "0.85rem", whiteSpace: "nowrap" }}
                  onClick={openImagesLog}
                  title="كل صور الكروت المرفوعة وتاريخ حفظ كل وحدة"
                >📜 سجل الصور</button>
              </div>

              <div style={{ display: "grid", gap: "14px", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", marginTop: "12px" }}>
                {records.length === 0 && (
                  <div style={{ fontSize: "0.85rem", color: "var(--muted)", gridColumn: "1 / -1", textAlign: "center", padding: "18px 0" }}>
                    ماكاين حتى كرت دابا — زيد اسم اللعبة فوق واضغط "➕ إضافة كرت".
                  </div>
                )}
                {records.map((rec) => {
                  const game = rec.tournamentName;
                  const busy = savingGame === game;
                  return (
                    <div key={rec.id} style={{ borderRadius: "16px", overflow: "hidden", background: "linear-gradient(160deg,rgba(41,182,246,0.12),rgba(0,20,45,0.55))", border: rec?.isHidden ? "1px dashed rgba(255,255,255,0.25)" : "1px solid var(--border)", display: "flex", flexDirection: "column", opacity: rec?.isHidden ? 0.55 : 1, position: "relative", transition: "opacity 0.2s ease" }}>
                      {rec?.isHidden && (
                        <div style={{ position: "absolute", top: "8px", left: "8px", zIndex: 2, background: "rgba(0,0,0,0.65)", color: "#fbbf24", fontSize: "0.7rem", fontWeight: 900, padding: "3px 9px", borderRadius: "999px", border: "1px solid rgba(251,191,36,0.4)" }}>
                        🙈 مخفي عن الزوار
                        </div>
                      )}
                      {/* اسم اللعبة فوق - قابل للتعديل */}
                      <input
                        type="text"
                        className="n-input"
                        style={{ padding: "11px 12px", textAlign: "center", fontWeight: 900, fontSize: "1rem", color: "#fff", background: "linear-gradient(135deg,rgba(41,182,246,0.22),rgba(41,182,246,0.06))", borderBottom: "1px solid var(--border)", border: "none" }}
                        value={gameNames[game] ?? (rec?.displayName || game)}
                        onChange={e => setGameNames(prev => ({ ...prev, [game]: e.target.value }))}
                        onBlur={() => handleGameNameBlur(game, gameNames[game] ?? (rec?.displayName || game), rec?.winnerName || "", rec?.image || "")}
                        placeholder={game}
                        disabled={busy}
                      />
                      {/* اسم الفائز */}
                      <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--border)", background: "rgba(0,0,0,0.2)" }}>
                        <input
                          type="text"
                          className="n-input"
                          style={{ width: "100%", paddingRight: "10px", textAlign: "center", fontSize: "0.85rem" }}
                          placeholder="👑 اسم الفائز"
                          value={winnerDrafts[game] ?? (rec?.winnerName || "")}
                          disabled={busy}
                          onChange={e => setWinnerDrafts(prev => ({ ...prev, [game]: e.target.value }))}
                          onBlur={() => handleWinnerBlur(game, rec?.image || "", rec?.winnerName || "")}
                        />
                      </div>
                      {/* الصورة الإضافية (image2) — تظهر بالمربع الأصفر في الصفحة العامة */}
                      <div style={{ padding: "8px 10px 0", fontSize: "0.72rem", fontWeight: 700, color: "#ffd27d", textAlign: "center" }}>🖼️ الصورة الإضافية</div>
                      <div style={{ width: "100%", aspectRatio: "16/7", background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", position: "relative", margin: "4px 0" }}>
                        {rec?.image2 ? <img src={rec.image2} alt={`${game} إضافية`} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span style={{ fontSize: "1.8rem", opacity: 0.4 }}>➕</span>}
                        {busy && <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: "0.8rem", fontWeight: 700 }}>...جارِ الحفظ</div>}
                      </div>
                      <div style={{ display: "flex", gap: "8px", padding: "0 12px 6px" }}>
                        <label className="btn btn-primary" style={{ flex: 1, textAlign: "center", cursor: busy ? "default" : "pointer", fontSize: "0.75rem", padding: "6px 8px", opacity: busy ? 0.6 : 1 }}>
                          {rec?.image2 ? "✏️ تغيير الإضافية" : "🖼️ إضافة إضافية"}
                          <input type="file" accept="image/*" disabled={busy} style={{ display: "none" }} onChange={e => { const f = e.target.files?.[0]; if (f) handleGameImage2(game, f, winnerDrafts[game] ?? (rec?.winnerName || ""), rec?.image || ""); e.currentTarget.value = ""; }} />
                        </label>
                        {rec?.image2 && (
                          <button className="btn btn-ghost" style={{ fontSize: "0.8rem", padding: "6px 10px" }} disabled={busy} onClick={() => handleClearGameImage2(game, winnerDrafts[game] ?? (rec?.winnerName || ""), rec?.image || "")} title="حذف الصورة الإضافية">🗑️</button>
                        )}
                      </div>

                      {/* صورة البطولة (image) — تظهر بالمربع الأخضر في الصفحة العامة */}
                      <div style={{ padding: "4px 10px 0", fontSize: "0.72rem", fontWeight: 700, color: "#8ef0a0", textAlign: "center" }}>🏆 صورة البطولة</div>
                      <div style={{ width: "100%", aspectRatio: "4/3", background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", position: "relative", marginTop: "4px" }}>
                        {rec?.image ? <img src={rec.image} alt={game} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span style={{ fontSize: "2.6rem", opacity: 0.4 }}>🏆</span>}
                        {busy && <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: "0.85rem", fontWeight: 700 }}>...جارِ الحفظ</div>}
                      </div>
                      {/* أزرار التعديل */}
                      <div style={{ display: "flex", flexDirection: "column", gap: "8px", padding: "10px 12px" }}>
                        <div style={{ display: "flex", gap: "8px" }}>
                          <label className="btn btn-primary" style={{ flex: 1, textAlign: "center", cursor: busy ? "default" : "pointer", fontSize: "0.8rem", padding: "7px 8px", opacity: busy ? 0.6 : 1 }}>
                            {rec?.image ? "✏️ تغيير الصورة" : "🖼️ إضافة صورة"}
                            <input type="file" accept="image/*" disabled={busy} style={{ display: "none" }} onChange={e => { const f = e.target.files?.[0]; if (f) handleGameImage(game, f, winnerDrafts[game] ?? (rec?.winnerName || "")); e.currentTarget.value = ""; }} />
                          </label>
                          {rec && (rec.image || rec.image2 || rec.winnerName) && (
                            <button className="btn btn-ghost" style={{ fontSize: "0.8rem", padding: "7px 10px" }} disabled={busy} onClick={() => handleClearGame(rec)} title="تفريغ اللعبة (يبقى الكرت)">🧹</button>
                          )}
                        </div>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          style={{ fontSize: "0.78rem", padding: "7px 8px", fontWeight: 800, color: "#f87171", borderColor: "rgba(248,113,113,0.4)" }}
                          disabled={busy}
                          onClick={() => handleDeleteGameCard(rec)}
                          title="حذف الكرت نهائيًا من الأدمن والزوار"
                        >❌ حذف الكرت نهائيًا</button>
                        {rec && (rec.image || rec.winnerName) && (
                          <button
                            type="button"
                            className="btn btn-ghost"
                            style={{
                              fontSize: "0.78rem",
                              padding: "7px 8px",
                              fontWeight: 800,
                              color: rec.isHidden ? "#4ade80" : "#fbbf24",
                              borderColor: rec.isHidden ? "rgba(74,222,128,0.35)" : "rgba(251,191,36,0.35)",
                            }}
                            disabled={busy}
                            onClick={() => toggleGameVisibility(rec)}
                            title={rec.isHidden ? "إظهار الكرت للزوار مرة ثانية" : "إخفاء الكرت عن الزوار (بدون حذف)"}
                          >
                            {rec.isHidden ? "👁️ إظهار الكرت" : "🙈 إخفاء الكرت"}
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn-ghost"
                          style={{ fontSize: "0.75rem", padding: "6px 8px", whiteSpace: "nowrap" }}
                          disabled={busy}
                          onClick={() => handleGenerateGameImage(game)}
                          title="يولّد صورة تلقائية من البراكيت الحالي + الفائز ويحفظها لهذي اللعبة"
                        >🎨 صورة البطولة الحالية</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            )}

            {/* 🧩 القائمتان جنب بعض عشان توفير المساحة — تنزل وحدة تحت الثانية
                تلقائياً على الشاشات الضيقة. */}
            <div className="panels-row">

            {/* ── 🎚️ نظام المستويات: اكتب اسم الحساب وشوف لفله بكل لعبة ── */}
            {canRecords && (
              <div className="card panel-half">
                <div className="lb-head">
                  <span style={{ fontSize: "1.15rem" }}>🎚️</span>
                  <h3 style={{ fontSize: "1.05rem", fontWeight: 900 }}>نظام المستويات</h3>
                  <span className="lb-sub">— {WINS_PER_LEVEL} فوزات = مستوى واحد</span>
                  <div className="lb-tools">
                    <button className="lb-btn" onClick={refreshLvlPlayers} disabled={lvlBusy}>🔄 تحديث</button>
                    <button className="lb-btn danger" onClick={resetAllLevels} disabled={lvlBusy}>🧹 تصفير الكل</button>
                  </div>
                </div>

                {lvlMsg && (
                  <div className={`lb-msg${lvlMsg.ok ? " ok" : " err"}`}>{lvlMsg.ok ? "✅" : "⚠️"} {lvlMsg.text}</div>
                )}

                {/* ➕ إضافة لاعب يدوياً: اسم + عدد فوزات + لعبة اختيارية */}
                <div className="lvl-add">
                  <input
                    type="text"
                    className="lb-name-input"
                    placeholder="اسم اللاعب..."
                    value={addName}
                    onChange={e => setAddName(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") addManualWinner(); }}
                  />
                  <input
                    type="number"
                    className="lb-pts-input"
                    min={1}
                    max={50}
                    title="عدد البطولات المكسوبة"
                    value={addWins}
                    onChange={e => setAddWins(Math.max(1, Math.min(50, parseInt(e.target.value) || 1)))}
                  />
                  <span className="lb-unit">فوز</span>
                  <select
                    className="lb-select"
                    value={addGame}
                    onChange={e => setAddGame(e.target.value)}
                    title="مطلوب — المستويات تُحسب لكل لعبة على حدة"
                  >
                    <option value="">اختر اللعبة...</option>
                    {records.map(r => (
                      <option key={r.id} value={r.tournamentName}>{r.displayName || r.tournamentName}</option>
                    ))}
                  </select>
                  <button
                    className="lb-btn primary"
                    disabled={addBusy || !addName.trim()}
                    onClick={addManualWinner}
                  >{addBusy ? "⏳ جارٍ..." : "➕ إضافة"}</button>
                </div>
                {addMsg && <div className={`lb-msg${addMsg.ok ? " ok" : " err"}`}>{addMsg.text}</div>}

                {/* 🔎 فلتر اختياري — القائمة تحت تظهر تلقائياً بدون بحث */}
                <input
                  type="text"
                  className="n-input"
                  style={{ width: "100%", padding: "9px 12px", margin: "8px 0 10px" }}
                  placeholder="🔎 فلتر بالاسم (اختياري)"
                  value={statsQuery}
                  onChange={(e) => { setStatsQuery(e.target.value); setLvlPage(0); }}
                />
                {statsError && <div style={{ color: "#ff4444", fontSize: "0.82rem", margin: "8px 0" }}>⚠️ {statsError}</div>}

                {/* 📋 أسماء اللاعبين — تظهر مباشرة، 8 بالصفحة */}
                <div className="lvl-list">
                  {lvlFiltered.length === 0 && (
                    <div className="lb-empty">
                      {lvlError
                        ? `⚠️ ${lvlError} — جرّب "🔄 تحديث"`
                        : statsQuery.trim()
                          ? "ما فيه اسم يطابق الفلتر"
                          : "ما فيه لاعب له فوزات بعد — أضف اسماً من فوق أو خلّص بطولة"}
                    </div>
                  )}
                  {lvlFiltered.slice(lvlPage * LVL_PER_PAGE, lvlPage * LVL_PER_PAGE + LVL_PER_PAGE).map((pl, i) => {
                    const rank = lvlPage * LVL_PER_PAGE + i + 1;
                    const isOpen = statsSearched.toLowerCase() === pl.username.toLowerCase();
                    return (
                      <button
                        key={pl.username}
                        className={`lvl-row as-btn${isOpen ? " on" : ""}`}
                        onClick={() => loadPlayerStats(pl.username)}
                        disabled={statsLoading}
                        title="اضغط عشان تشوف لفله بكل لعبة"
                      >
                        <span className="lvl-rank">{rank}</span>
                        <span className="lvl-name">{pl.username}</span>
                        <span className="lvl-badge">⭐ {levelFromWins(pl.wins)}</span>
                        <span className="lvl-wins" title={`${pl.wins} فوز · المستوى ${levelFromWins(pl.wins)}`}>{pl.wins}</span>
                        <span className="lvl-go">{isOpen ? "▾" : "←"}</span>
                      </button>
                    );
                  })}
                </div>

                {lvlFiltered.length > LVL_PER_PAGE && (() => {
                  const pages = Math.ceil(lvlFiltered.length / LVL_PER_PAGE);
                  const cur = Math.min(lvlPage, pages - 1);
                  return (
                    <div className="lvl-pager">
                      <button className="lvl-pg-nav" disabled={cur === 0} onClick={() => setLvlPage(cur - 1)}>›</button>
                      {Array.from({ length: pages }, (_, i) => (
                        <button key={i} className={`lvl-pg${i === cur ? " on" : ""}`} onClick={() => setLvlPage(i)}>{i + 1}</button>
                      ))}
                      <button className="lvl-pg-nav" disabled={cur >= pages - 1} onClick={() => setLvlPage(cur + 1)}>‹</button>
                    </div>
                  );
                })()}

                {statsData && (
                  <div style={{ marginTop: "12px" }}>
                    <div className="lvl-detail-head">
                      <span>👤 <b>{statsData.username}</b></span>
                      <span className="lvl-detail-sum">
                        إجمالي الفوزات: {Object.values(statsData.wins || {}).reduce((a, b) => a + b, 0)}
                      </span>
                      <button
                        className="lb-btn danger sm"
                        disabled={lvlBusy}
                        onClick={() => resetOnePlayerLevel(statsData.username)}
                        title="تصفير فوزات هذا اللاعب في كل الألعاب"
                      >↺ صفّر</button>
                      <button className="cardpick-close" onClick={() => { setStatsData(null); setStatsSearched(""); }} aria-label="إغلاق">✕</button>
                    </div>
                    <div className="lvl-list">
                      {records.length === 0 && (
                        <div className="lb-empty">ما فيه ألعاب مضافة بعد</div>
                      )}
                      {records.map((rec) => {
                        const game = rec.tournamentName;
                        const wins = statsData.wins?.[game] ?? 0;
                        const level = levelFromWins(wins);
                        const inLevel = progressWithinLevel(wins);
                        const pct = (inLevel / WINS_PER_LEVEL) * 100;
                        return (
                          <div key={rec.id} className="lvl-row">
                            <span className="lvl-name" title={rec.displayName || game}>{rec.displayName || game}</span>
                            <span className="lvl-badge">⭐ {level}</span>
                            <div className="lvl-track" title={`${wins} فوز · باقي ${WINS_PER_LEVEL - inLevel} للفل ${level + 1}`}>
                              <div className="lvl-fill" style={{ width: `${pct}%` }} />
                            </div>
                            <span className="lvl-wins">{wins}</span>
                            <div className="lvl-ctrl">
                              <button type="button" className="lb-step" onClick={() => adjustPlayerWin(game, -1)} disabled={wins <= 0} title="نقص فوز">−</button>
                              <button type="button" className="lb-step" onClick={() => adjustPlayerWin(game, 1)} title="زيادة فوز">＋</button>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                  </div>
                )}
              </div>
            )}

            {/* ── 🏆 نقاط الأكثر انتصاراً: تحكم يدوي كامل (تعديل/تصفير) ── */}
            {canRecords && (
              <div className="card panel-half">
                <div className="lb-head">
                  <span style={{ fontSize: "1.15rem" }}>🏆</span>
                  <h3 style={{ fontSize: "1.05rem", fontWeight: 900 }}>نقاط الأكثر انتصاراً</h3>
                  <span className="lb-sub">— عدّل نقاط أي لاعب أو صفّرها يدوياً</span>
                  <div className="lb-tools">
                    <select
                      className="lb-select"
                      value={lbLimit}
                      onChange={e => { const n = Number(e.target.value); setLbLimit(n); loadLeaderboard(n); }}
                      title="كم لاعب يظهر بالقائمة"
                    >
                      <option value={5}>أعلى 5</option>
                      <option value={10}>أعلى 10</option>
                      <option value={20}>أعلى 20</option>
                      <option value={50}>أعلى 50</option>
                    </select>
                    <button className="lb-btn" onClick={() => loadLeaderboard()} disabled={lbBusy}>🔄 تحديث</button>
                    <button className="lb-btn danger" onClick={resetAllPoints} disabled={lbBusy}>🧹 تصفير الكل</button>
                  </div>
                </div>

                {lbMsg && (
                  <div className={`lb-msg${lbMsg.ok ? " ok" : " err"}`}>{lbMsg.ok ? "✅" : "⚠️"} {lbMsg.text}</div>
                )}

                {/* ➕ إضافة/تعيين نقاط لاسم مو موجود بالقائمة */}
                <div className="lb-add">
                  <input
                    type="text"
                    className="lb-name-input"
                    placeholder="اسم اللاعب..."
                    value={lbNewName}
                    onChange={e => setLbNewName(e.target.value)}
                  />
                  <input
                    type="number"
                    className="lb-pts-input"
                    min={0}
                    value={lbNewPts}
                    onChange={e => setLbNewPts(Math.max(0, parseInt(e.target.value) || 0))}
                  />
                  <span className="lb-unit">نقطة</span>
                  <button
                    className="lb-btn primary"
                    disabled={lbBusy || !lbNewName.trim()}
                    onClick={() => { applyPoints(lbNewName.trim(), lbNewPts); setLbNewName(""); }}
                  >✍️ تعيين</button>
                </div>

                {/* 🔎 فلتر اختياري بالاسم — نفس شكل فلتر نظام المستويات */}
                <input
                  type="text"
                  className="n-input"
                  style={{ width: "100%", padding: "9px 12px", margin: "8px 0 10px" }}
                  placeholder="🔎 فلتر بالاسم (اختياري)"
                  value={lbQuery}
                  onChange={e => setLbQuery(e.target.value)}
                />

                <div className="lb-list">
                  {lbError && !lbBusy && (
                    <div className="lb-msg err">⚠️ {lbError}</div>
                  )}
                  {!lbError && lbFiltered.length === 0 && !lbBusy && (
                    <div className="lb-empty">
                      {lbQuery.trim() ? "ما فيه اسم يطابق الفلتر" : "ما فيه نقاط مسجّلة بعد"}
                    </div>
                  )}
                  {lbFiltered.map(({ row, rank }) => {
                    const i = rank;
                    const draft = lbDraft[row.username];
                    const shown = draft !== undefined ? draft : String(row.wins);
                    const changed = draft !== undefined && Number(draft) !== row.wins;
                    return (
                      <div key={row.username} className="lb-row">
                        <span className={`lb-rank r${i + 1}`}>{i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : i + 1}</span>
                        <span className="lb-name" title={row.username}>{row.username}</span>
                        <div className="lb-ctrl">
                          <button className="lb-step" disabled={lbBusy || row.wins <= 0} onClick={() => applyPoints(row.username, row.wins - 1)} title="نقص نقطة">−</button>
                          <input
                            type="number"
                            className="lb-pts-input"
                            min={0}
                            value={shown}
                            onChange={e => setLbDraft(d => ({ ...d, [row.username]: e.target.value }))}
                          />
                          <button className="lb-step" disabled={lbBusy} onClick={() => applyPoints(row.username, row.wins + 1)} title="زد نقطة">+</button>
                          {changed && (
                            <button className="lb-btn primary sm" disabled={lbBusy} onClick={() => applyPoints(row.username, Number(draft) || 0)}>حفظ</button>
                          )}
                          <button className="lb-btn danger sm" disabled={lbBusy || row.wins === 0} onClick={() => applyPoints(row.username, 0)} title="تصفير هذا اللاعب">↺ صفّر</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            </div>{/* /panels-row */}

            {!canTournament && (
              <div className="card" style={{ textAlign: "center", padding: "28px 16px", opacity: 0.85 }}>
                <div style={{ fontSize: "1.6rem", marginBottom: "8px" }}>🔒</div>
                <div style={{ fontWeight: 800, marginBottom: "4px" }}>ما عندك صلاحية إدارة البطولة</div>
                <div style={{ fontSize: "0.8rem", color: "var(--muted)" }}>اطلب من الأدمن الرئيسي يفعّلها لك من "إدارة المساعدين"</div>
              </div>
            )}

            {/* SETUP SCREEN */}
            {canTournament && st.phase === "setup" && (
              <div className="card">
                {/* 🎛️ لوحة إعداد البطولة: اسم البطولة ومهلة الانضمام بصف واحد
                    مرتّب بدل ما يكونون متفرقين بسطور. */}
                <div className="setup-bar">
                  <div className="setup-field setup-name">
                    <label htmlFor="t-name">🏆 اسم البطولة</label>
                    <input
                      id="t-name"
                      type="text"
                      className="n-input"
                      placeholder="اكتب اسم البطولة..."
                      value={st.name}
                      onChange={e => setSt(prev => ({ ...prev, name: e.target.value }))}
                      onBlur={() => sync(st)}
                    />
                  </div>

                  <div className="setup-sep" />

                  {/* 🟢 يخلي صفحة /bracket تعرض بوابة الانضمام (عدّاد + !دخول
                      + عدد المنضمين) قبل ما تبدأ البطولة — عشان تحطها بالبث
                      من بدري بدل ما تكون فاضية. */}
                  <div className="setup-field">
                    <label>📺 شجرة OBS</label>
                    {/* العرض شغّال دايماً — صفحة /bracket تعرض بوابة الانضمام
                        والمشاركين تلقائياً قبل بدء البطولة، فما فيه شي تفعّله.
                        هذا الزر مجرد اختصار يفتح النافذة بجهازك. */}
                    <button
                      className="green-open-btn"
                      title="يفتح صفحة الشجرة بخلفية شفافة — حطها كمصدر متصفح بـ OBS"
                      onClick={() => window.open("/bracket", "ik3mo-bracket", "width=1100,height=760,noopener,noreferrer")}
                    >
                      ↗ افتح النافذة
                    </button>
                  </div>

                  <div className="setup-sep" />

                  <div className="setup-field setup-join">
                    <label>⏱️ مهلة الانضمام</label>
                    {st.joinDeadline ? (
                      <div className="join-row">
                        <span className={`join-clock${getJoinSecondsLeft() <= 10 ? " hot" : ""}`}>
                          {getJoinSecondsLeft() > 0
                            ? `${String(Math.floor(getJoinSecondsLeft() / 60)).padStart(2, "0")}:${String(getJoinSecondsLeft() % 60).padStart(2, "0")}`
                            : "⛔ انتهى"}
                        </span>
                        <span className="join-hint">
                          {getJoinSecondsLeft() > 0 ? "الباب مفتوح" : "الباب مقفل"}
                        </span>
                        <button className="join-btn ghost" onClick={cancelJoinWindow}>✕ إلغاء</button>
                      </div>
                    ) : (
                      <div className="join-row">
                        <input
                          type="number"
                          className="join-mins"
                          min={1}
                          max={60}
                          value={joinDurationInput}
                          onChange={e => setJoinDurationInput(Math.max(1, parseInt(e.target.value) || 1))}
                        />
                        <span className="join-unit">دقيقة</span>
                        <button className="join-btn" onClick={() => openJoinWindow(joinDurationInput)}>🕐 افتح الباب</button>
                      </div>
                    )}
                  </div>
                  <div className="setup-sep" />

                  {/* 👥 نظام الفرق — انتقل من صف مستقل لداخل لوحة الإعداد */}
                  <div className="setup-field">
                    <label>👥 نظام الفرق</label>
                    <div className="teams-row">
                      <label className="switch">
                        <input type="checkbox" checked={st.isTeams} onChange={e => toggleTeams(e.target.checked)} />
                        <span className="slider" />
                      </label>
                      {st.isTeams && (
                        <>
                          <input
                            type="number"
                            className="join-mins"
                            value={st.teamSize}
                            min={1}
                            max={10}
                            title="عدد اللاعبين بكل فريق"
                            onChange={e => update({ ...st, teamSize: Math.max(1, Math.min(10, parseInt(e.target.value) || 1)) })}
                          />
                          <span className="join-unit">لكل فريق</span>
                          <button className="join-btn ghost" onClick={shuffleTeams} title="يفرّط اللاعبين ويرتبهم بفرق عشوائية جديدة">
                            🎲 ترتيب عشوائي
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="setup-sep" />

                  {/* ⏯️ بدء تلقائي: لو مفعّل، أول ما تخلص مهلة الباب تبدأ
                      البطولة لحالها بدون ما تضغط "ابدأ البطولة". */}
                  <div className="setup-field">
                    <label>⏯️ بدء تلقائي</label>
                    <div className="teams-row">
                      <label className="switch">
                        <input
                          type="checkbox"
                          checked={!!st.autoStart}
                          onChange={e => update({ ...st, autoStart: e.target.checked })}
                        />
                        <span className="slider" />
                      </label>
                      <span className="join-unit">
                        {st.autoStart ? "تبدأ فور انتهاء مهلة الباب" : "مقفل — تبدأ يدوياً"}
                      </span>
                    </div>
                  </div>

                  <div className="setup-sep" />

                  {/* ⚡ إجراءات البطولة — تفريغ + بدء */}
                  <div className="setup-field">
                    <label>⚡ الإجراءات</label>
                    <div className="teams-row">
                      <button className="join-btn ghost" onClick={() => { update({ ...st, players: [], entryLog: [] }); }}>🧹 تفريغ</button>
                      <button
                        className={`join-btn${getStartBlockReason() ? " is-off" : ""}`}
                        onClick={startTournament}
                        title={getStartBlockReason() || "ابدأ البطولة"}
                      >
                        🚀 ابدأ البطولة
                      </button>
                    </div>
                  </div>
                </div>

                {/* عرض اللاعبين — في وضع "غير محدود" ما نعرض إلا خانات اللاعبين اللي انضموا فعلاً
                    (تُنشأ تلقائياً بمجرد ما حد يكتب أمر الانضمام بالشات). الأسماء غير قابلة
                    للتعديل اليدوي (تُقرأ من الشات مباشرة)، وكل عضو بالفريق له إطار مستقل
                    مفصول بعلامة & عن باقي أعضاء نفس الفريق. */}
                <div className="reg-head">
                  <span className="reg-title">👥 {st.isTeams ? "الفرق المسجلة" : "المسجلين من الشات"}</span>
                  <span className="reg-count">{st.players.filter(p => p).length}</span>
                  <span className="reg-hint">
                    {st.joinDeadline && getJoinSecondsLeft() > 0
                      ? "الباب مفتوح الآن — أي دخول بالشات ينضاف مباشرة"
                      : <>الانضمام تلقائي بكتابة <b>دخول</b> أو <b>!دخول</b> بالشات</>}
                  </span>
                  {/* 🤖 تنضاف بأي وقت — قبل فتح الباب أو وهو مفتوح — عشان تقدر
                      تجرّب شكل الشجرة فوراً بدون ما تنتظر أحد ينضم. */}
                  <div className="bots-group" title="لاعبين وهميين لتجربة الشجرة — تنضاف حتى والباب مفتوح">
                    <span className="bots-label">🤖 بوتات</span>
                    <button className="bots-btn" onClick={() => addBots(2)}>+2</button>
                    <button className="bots-btn" onClick={() => addBots(4)}>+4</button>
                    <button className="bots-btn" onClick={() => addBots(8)}>+8</button>
                  </div>
                </div>

                <div className="ik3mo-names-grid">
                  {st.players
                    .map((p, i) => ({ i, p }))
                    .filter((x) => x.p)
                    .map(({ i, p }) => {
                      const members = p.split(" N ").filter(Boolean);
                      return (
                        <div key={i} className="ik3mo-team-slot">
                          {members.map((m, mi) => (
                            <span key={mi} style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                              <span className="ik3mo-chip-wrap">
                                <span className="ik3mo-chip" title={m}>
                                  <span className="ik3mo-chip-text">{m}</span>
                                  <button
                                    type="button"
                                    className="ik3mo-chip-x"
                                    title="طرد اللاعب"
                                    onClick={() => removeMemberFromSlot(i, mi)}
                                  >✕</button>
                                </span>
                              </span>
                              {mi < members.length - 1 && <span className="ik3mo-amp">&</span>}
                            </span>
                          ))}
                        </div>
                      );
                    })}
                </div>

              </div>
            )}

            {/* TOURNAMENT SCREEN */}
            {canTournament && st.phase === "tournament" && (
              <div>
                {/* ⚠️ قبل: اسم البطولة كان position:absolute بنص الشريط، فيتداخل
                    مع أزرار اليسار (خصوصاً خانة الماتش العشوائي) لما تطول.
                    الحين كل شي بتدفق flex طبيعي — العنوان بالنص بمرونة
                    والمجموعتان على الطرفين، وما فيه تداخل مهما طال الاسم. */}
                <div className="toolbar tb-flex">
                  <div className="tb-side">
                    <button className="btn-stop" onClick={() => resetTournament()} title="يوقف البطولة الحالية ويرجّعك لشاشة الإعداد">⛔ إيقاف البطولة</button>
                    <button className="btn btn-ghost" onClick={undoLastWin} disabled={!st.winHistory?.length} title={st.winHistory?.length ? "تراجع عن آخر نتيجة فوز" : "ما فيه نتيجة نتراجع عنها"} style={{ padding: "6px 14px", fontSize: "0.85rem", opacity: st.winHistory?.length ? 1 : 0.4, cursor: st.winHistory?.length ? "pointer" : "not-allowed" }}>↩️ تراجع</button>
                    <button
                      className="btn btn-ghost"
                      title="يفتح نافذة منفصلة فيها شجرة البطولة فقط بخلفية خضراء (Chroma Key) — مناسبة للستريمر بدل ما يفتح صفحة الأدمن كاملة"
                      style={{ padding: "6px 14px", fontSize: "0.85rem" }}
                      onClick={() => window.open("/bracket", "ik3mo-bracket", "width=1100,height=760,noopener,noreferrer")}
                    >
                      📺 نافذة الشجرة (خلفية شفافة)
                    </button>

                    {/* 🎲 الماتش العشوائي — مدموج بنفس الشريط بدل ما يكون بصف مستقل */}
                    <span className="tb-sep" />
                    <button className="btn-pick" onClick={pickRandomMatch} disabled={pickRunning}>🎲 ماتش عشوائي</button>
                    <div className="pick-inline">
                      <span className={slotClassA}>{slotA}</span>
                      <span className="pick-vs">VS</span>
                      <span className={slotClassB}>{slotB}</span>
                    </div>
                  </div>
                  <div className="tb-title">
                    <span>{st.name ? `🏆 ${st.name}` : ""}</span>
                  </div>
                  <div className="tb-side tb-stats">
                    <span>{st.isTeams ? "الفرق:" : "اللاعبون:"}</span> <b>{st.players.length}</b>
                    {st.byeN > 0 && <span style={{ color: "var(--blue)" }}>(بايب: {st.byeN})</span>}
                    <span style={{ opacity: 0.5 }}>·</span>
                    <span>الجولة الحالية:</span> <b>{st.cur + 1}</b>
                  </div>
                </div>

                <BracketDisplay st={st} isAdmin={true} pickedMatchId={st.pickedMatchId ?? null} onWin={handleWin} />

                {/* ✅ لما تنتهي البطولة (يتحدد البطل) يظهر زر واضح يرجع لصفحة الأدمن الرئيسية (شاشة الإعداد) */}
                {st.champion && (
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "10px", marginTop: "24px" }}>
                    <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: "10px" }}>
                      <button
                        className="btn btn-primary"
                        style={{ padding: "12px 28px", fontSize: "0.95rem", opacity: autoCardBusy ? 0.6 : 1, cursor: autoCardBusy ? "not-allowed" : "pointer" }}
                        disabled={autoCardBusy}
                        onClick={autoCreateWinnerCard}
                        title="يضيف كرت جديد بسجل البطولات، اسم اللعبة واسم الفائز تلقائياً بدون كتابة"
                      >
                        {autoCardBusy ? "⏳ جارِ الإنشاء..." : "🪄 إنشاء كرت تلقائي"}
                      </button>
                      <button
                        className="btn btn-primary"
                        style={{ padding: "12px 28px", fontSize: "0.95rem" }}
                        onClick={() => setCardPickOpen(true)}
                        title="تختار كرت موجود من سجل البطولات، ينحفظ فيه اسم الفائز، وتُقفل البطولة تلقائياً"
                      >
                        🏆 اعتمد الفائز بكرت
                      </button>
                    </div>
                    {autoCardStatus && (
                      <div style={{ fontSize: "0.85rem", fontWeight: 700, color: autoCardStatus.ok ? "#4ade80" : "#f87171", textAlign: "center" }}>
                        {autoCardStatus.msg}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

      </div>

      {/* 📜 سجل صور الكروت — كل صورة مع لعبتها وتاريخ رفعها */}
      {imgLogOpen && (
        <div className="cardpick-overlay" onClick={() => setImgLogOpen(false)}>
          <div className="cardpick imglog" onClick={e => e.stopPropagation()}>
            <div className="cardpick-head">
              <span>📜 سجل صور الكروت</span>
              <button className="cardpick-close" onClick={() => setImgLogOpen(false)} aria-label="إغلاق">✕</button>
            </div>
            <p className="cardpick-sub">
              سجل دائم: كل حفظ لصورة بطولة أو فائز يُسجّل هنا بلقطته وتاريخه.
            </p>

            <div className="imglog-tools">
              <label className={`lb-btn primary${imgLogBusy ? " is-off" : ""}`}>
                ➕ أضف صورة
                <input
                  type="file"
                  accept="image/*"
                  disabled={imgLogBusy}
                  style={{ display: "none" }}
                  onChange={e => { const f = e.target.files?.[0]; if (f) addImageToLog(f); e.currentTarget.value = ""; }}
                />
              </label>
              <button className="lb-btn" onClick={openImagesLog} disabled={imgLogBusy}>🔄 تحديث</button>
              <button
                className={`lb-btn${imgLogShowAll ? " primary" : ""}`}
                onClick={() => setImgLogShowAll(v => !v)}
                title="يعرض الصور الموجودة بالمكتبة وغير المرتبطة بأي كرت — تقدر تربطها من جديد"
              >{imgLogShowAll ? "🏆 صور البطولات فقط" : "📂 اعرض كل الصور"}</button>
            </div>

            {imgLogBusy && <div className="cardpick-busy">⏳ جارٍ العمل...</div>}
            {imgLogErr && <div className="lb-msg err">⚠️ {imgLogErr}</div>}

            {!imgLogBusy && !imgLogErr && (
              <>
                {imgLogDays.length === 0 ? (
                  <div className="cardpick-empty">ما فيه سجل بعد — أي حفظ لصورة أو فائز ينسجّل هنا تلقائياً</div>
                ) : (
                  <div className="imglog-days">
                    {imgLogDays.map((day, di) => (
                      <div className="imglog-day" key={di}>
                        <div className="imglog-date-big">{day.label}</div>
                        <div className="imglog-row">
                          {day.items.map(row => (
                            <div className="imglog-card" key={row.id}>
                              <span className={`imglog-winner${row.winnerName ? "" : " none"}`}>
                                {row.winnerName ? `🏆 ${row.winnerName}` : "— بدون فائز —"}
                              </span>
                              <a href={row.image} target="_blank" rel="noopener noreferrer" title="افتح الصورة بالحجم الكامل">
                                <img className="imglog-pic" src={row.image} alt="" loading="lazy" />
                              </a>
                              <span className="imglog-game">{row.displayName || row.tournamentName}</span>
                              <span className="imglog-time">
                                {new Date(row.savedAt).toLocaleTimeString("ar-SA", { hour: "2-digit", minute: "2-digit" })}
                              </span>
                              <button
                                className="imglog-del"
                                disabled={imgLogBusy}
                                onClick={() => removeHistoryRow(row.id)}
                                title="حذف هذا السطر من السجل (الكرت والصورة ما يتأثرون)"
                              >🗑️ من السجل</button>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* 📂 استرجاع: صور موجودة بالمكتبة وغير مستخدمة بأي كرت */}
                {imgLogShowAll && (
                  <div className="imglog-day" style={{ marginTop: "22px" }}>
                    <div className="imglog-date-big">📂 صور بالمكتبة غير مرتبطة بكرت</div>
                    {orphanImages.length === 0 ? (
                      <div className="cardpick-empty">ما فيه صور غير مرتبطة</div>
                    ) : (
                      <div className="imglog-row">
                        {orphanImages.map(img => (
                          <div className="imglog-card" key={img.publicId}>
                            <span className="imglog-winner none">🔓 غير مرتبطة</span>
                            <a href={img.url} target="_blank" rel="noopener noreferrer">
                              <img className="imglog-pic" src={img.url} alt="" loading="lazy" />
                            </a>
                            <div className="imglog-link">
                              <select
                                className="imglog-select"
                                value={linkTarget[img.publicId] || ""}
                                onChange={e => setLinkTarget(t => ({ ...t, [img.publicId]: e.target.value }))}
                              >
                                <option value="">اربطها بكرت...</option>
                                {records.map(r => (
                                  <option key={r.id} value={r.tournamentName}>{r.displayName || r.tournamentName}</option>
                                ))}
                              </select>
                              <button
                                className="imglog-linkbtn"
                                disabled={imgLogBusy || !linkTarget[img.publicId]}
                                onClick={() => linkImageToCard(img.url, linkTarget[img.publicId])}
                              >🔗 ربط</button>
                            </div>
                            <button
                              className="imglog-del"
                              disabled={imgLogBusy}
                              onClick={() => removeImageFromLog(img.publicId, img.url)}
                              title="حذف الصورة نهائياً من المكتبة"
                            >🗑️ حذف نهائي</button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* 🏆 نافذة اختيار الكرت اللي يروح له اسم الفائز — بعد الاختيار
          ينحفظ الفائز بالكرت وتُقفل البطولة تلقائياً. */}
      {cardPickOpen && (
        <div className="cardpick-overlay" onClick={() => !cardPickBusy && setCardPickOpen(false)}>
          <div className="cardpick" onClick={e => e.stopPropagation()}>
            <div className="cardpick-head">
              <span>🏆 وين يروح الفائز؟</span>
              <button className="cardpick-close" onClick={() => setCardPickOpen(false)} aria-label="إغلاق">✕</button>
            </div>
            <p className="cardpick-sub">
              اختر الكرت اللي ينحفظ فيه <b>{st.champion || "الفائز"}</b> — وبعدها تُقفل البطولة تلقائياً.
            </p>

            {records.length === 0 ? (
              <div className="cardpick-empty">ما فيه كروت بسجل البطولات — استخدم "🪄 إنشاء كرت تلقائي"</div>
            ) : (
              <div className="cardpick-list">
                {records.map(rec => (
                  <button
                    key={rec.id}
                    className="cardpick-item"
                    disabled={cardPickBusy}
                    onClick={() => assignWinnerToCard(rec)}
                  >
                    <span className="cardpick-name">{rec.displayName || rec.tournamentName}</span>
                    <span className="cardpick-cur">
                      {rec.winnerName ? `الحالي: ${rec.winnerName}` : "ما فيه فائز"}
                    </span>
                    <span className="cardpick-go">←</span>
                  </button>
                ))}
              </div>
            )}
            {cardPickBusy && <div className="cardpick-busy">⏳ جارِ الحفظ وإقفال البطولة...</div>}
          </div>
        </div>
      )}

      {/* 🎨 لوحة تخصيص ثيم/إيموجي/لقب الفائز — تظهر التغييرات فورًا بالصفحة العامة */}
      {editingWinner && (
        <div
          onClick={() => setEditingWinner(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: "16px" }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: "var(--panel, #12161f)", borderRadius: "18px", padding: "20px", width: "100%", maxWidth: "380px", border: "1px solid rgba(255,255,255,0.14)" }}
          >
            <div style={{ fontWeight: 900, fontSize: "1.05rem", marginBottom: "14px" }}>🎨 تخصيص الفائز: {editingWinner.name}</div>

            <div style={{ marginBottom: "12px" }}>
              <div style={{ fontSize: "0.85rem", marginBottom: "6px", color: "var(--muted)" }}>الثيم/اللون:</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                {WINNER_THEMES.map(t => (
                  <button
                    key={t.key}
                    title={t.label}
                    onClick={() => saveWinnerCustomization({ color: t.key })}
                    style={{
                      width: "34px", height: "34px", borderRadius: "50%", background: t.gradient, cursor: "pointer",
                      border: (editingWinner.color || "gold") === t.key ? "3px solid #fff" : "2px solid rgba(255,255,255,0.25)",
                    }}
                  />
                ))}
              </div>
            </div>

            <div style={{ marginBottom: "12px" }}>
              <div style={{ fontSize: "0.85rem", marginBottom: "6px", color: "var(--muted)" }}>الإيموجي:</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                {WINNER_EMOJIS.map(em => (
                  <button
                    key={em}
                    onClick={() => saveWinnerCustomization({ emoji: em })}
                    style={{
                      width: "34px", height: "34px", borderRadius: "10px", fontSize: "1.05rem", cursor: "pointer",
                      background: editingWinner.emoji === em ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.08)",
                      border: "1px solid rgba(255,255,255,0.16)",
                    }}
                  >{em}</button>
                ))}
              </div>
            </div>

            <div style={{ marginBottom: "16px" }}>
              <div style={{ fontSize: "0.85rem", marginBottom: "6px", color: "var(--muted)" }}>لقب مخصص (اختياري):</div>
              <input
                type="text"
                className="n-input"
                style={{ width: "100%" }}
                placeholder="مثال: بطل النسخة الأولى"
                defaultValue={editingWinner.badgeText || ""}
                onBlur={(e) => saveWinnerCustomization({ badgeText: e.target.value })}
              />
            </div>

            <button className="btn btn-primary" style={{ width: "100%", padding: "10px" }} onClick={() => setEditingWinner(null)}>تم</button>
          </div>
        </div>
      )}

    </>
  );
}

interface PusherClient {
  subscribe(channel: string): PusherChannel;
  unsubscribe(channel: string): void;
  connection: { bind(event: string, fn: (...args: unknown[]) => void): void };
}
interface PusherChannel {
  name: string;
  bind(event: string, fn: (...args: unknown[]) => void): void;
  bind_global?(fn: (event: string, data: unknown) => void): void;
  unbind_all(): void;
}
