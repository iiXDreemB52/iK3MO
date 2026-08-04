import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Router, type Request, type Response, type NextFunction } from "express";
import { logger } from "../lib/logger";
import { uploadImageToCloudinary, getCloudinaryStatus, isCloudinaryConfigured, listCloudinaryImages, deleteCloudinaryImage } from "../lib/cloudinary";

const router = Router();

const BYE = "__BYE__";

export interface Match {
  a: string | null;
  b: string | null;
  winner: string | null;
  isBye: boolean;
}

export interface EntryLogItem {
  user: string;
  time: string;
}

export interface Winner {
  id: string;
  name: string;
  gameType: string;
  tournamentName: string;
  date: string;
}

export interface TournamentState {
  phase: "setup" | "tournament";
  size: number;
  players: string[];
  rounds: Match[][];
  cur: number;
  bSize: number;
  byeN: number;
  isTeams: boolean;
  teamSize: number;
  name: string;
  gameType: string;
  champion: string;
  scheduledAt: string;
  lastWinner: string;
  lastGameType: string;
  lastTournamentName: string;
  entryLog: EntryLogItem[];
  winnerHistory: Winner[];
  updatedAt: number;
}

let state: TournamentState = {
  phase: "setup",
  size: 16,
  players: [],
  rounds: [],
  cur: 0,
  bSize: 16,
  byeN: 0,
  isTeams: false,
  teamSize: 2,
  name: "",
  gameType: "",
  champion: "",
  scheduledAt: "",
  lastWinner: "",
  lastGameType: "",
  lastTournamentName: "",
  entryLog: [],
  winnerHistory: [],
  updatedAt: Date.now(),
};

const clients = new Set<Response>();

// Load DB helpers at runtime to avoid TS build-order issues in the workspace
// eslint-disable-next-line @typescript-eslint/no-var-requires
const dbModule: any = require("@workspace/db");
// جداول Drizzle — نحتاجها للخطة الاحتياطية بمسار /player/levels لو حزمة
// قاعدة البيانات المنشورة قديمة وما فيها getPlayerLevels / resetAllPlayerWins.
let dbSchemaModule: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  dbSchemaModule = require("@workspace/db/schema");
} catch {
  dbSchemaModule = null;
}
const { 
  initializeDatabase, 
  getTournamentState, 
  saveTournamentState, 
  getWinners: dbGetWinners, 
  addWinner: dbAddWinner,
  getTournamentRecords: dbGetRecords,
  upsertTournamentRecord: dbUpsertRecord,
  deleteTournamentRecord: dbDeleteRecord,
  setTournamentRecordVisibility: dbSetRecordVisibility,
  getPlayerWins: dbGetPlayerWins,
  getPlayerLevels: dbGetPlayerLevels,
  addRecordHistory: dbAddRecordHistory,
  getRecordHistory: dbGetRecordHistory,
  deleteRecordHistory: dbDeleteRecordHistory,
  setPlayerWins: dbSetPlayerWins,
  resetAllPlayerWins: dbResetAllPlayerWins,
  incrementPlayerWin: dbIncrementPlayerWin,
  incrementPlayerMatchWin: dbIncrementPlayerMatchWin,
  setPlayerMatchWins: dbSetPlayerMatchWins,
  resetAllPlayerMatchWins: dbResetAllPlayerMatchWins,
  getLeaderboard: dbGetLeaderboard,
  normalizePlayerName: dbNormalizePlayerName,
  getArchives: dbGetArchives,
  getArchiveById: dbGetArchiveById,
  addArchive: dbAddArchive,
  getAdminHelpers: dbGetHelpers,
  findAdminHelperByCode: dbFindHelperByCode,
  addAdminHelper: dbAddHelper,
  updateAdminHelperPermissions: dbUpdateHelperPermissions,
  deleteAdminHelper: dbDeleteHelper,
  USE_LOCAL_STORE: dbUsesLocalStore,
} = dbModule;

// تحذير عند الإقلاع لو ما فيه ADMIN_PASSWORD محدد فـ بيئة production — بدون
// هذا التحذير، السيرفر يقدر يشتغل بدون أي كلمة مرور أدمن حقيقية بلا ما يدري حد.
if (process.env.NODE_ENV === "production" && !process.env.ADMIN_PASSWORD) {
  logger.warn("⚠️ ADMIN_PASSWORD غير محدد فـ متغيرات البيئة — لوحة الأدمن ما عندهاش كلمة مرور حقيقية!");
}

// Initialize DB connection and load persisted state (if any)
initializeDatabase()
  .then(async () => {
    try {
      const persisted = await getTournamentState();
      if (persisted) {
        // persisted may contain DB-specific fields; merge safely
        state = { ...state, ...(persisted as any) };
        logger.info({ loaded: true }, "Loaded tournament state from DB");
      } else {
        logger.info({ loaded: false }, "No persisted tournament state found");
      }
    } catch (loadErr: any) {
      logger.error({ err: loadErr }, "Failed to load persisted state");
    }
  })
  .catch((initErr: any) => {
    logger.error({ err: initErr }, "Failed to initialize database");
  });

// أدمن تجريبي للـ localhost يتحكم فيه ملف على القرص:
// - إذا كان الملف موجود  → تسجيل دخول الأدمن التجريبي يشتغل (كلمة المرور = محتوى الملف، أو "localadmin" لو فاضي)
// - إذا حذفت الملف       → الأدمن التجريبي يختفي فوراً (بدون إعادة تشغيل الخادم)
// - إذا رجّعت الملف       → يرجع يشتغل
// مكان الملف الافتراضي: جذر المشروع باسم dev-admin.txt (أو حدد مساراً عبر DEV_ADMIN_FILE).
const DEV_ADMIN_DEFAULT_PASSWORD = "localadmin";

function devAdminFileCandidates(): string[] {
  const candidates: string[] = [];
  if (process.env.DEV_ADMIN_FILE) candidates.push(process.env.DEV_ADMIN_FILE);
  // بالنسبة لمجلد التشغيل الحالي (مثلاً لو شغّلت الخادم من جذر المشروع)
  candidates.push(path.resolve(process.cwd(), "dev-admin.txt"));
  candidates.push(path.resolve(process.cwd(), "..", "..", "dev-admin.txt"));
  // بالنسبة لموقع ملف الخادم المبنيّ (artifacts/api-server/dist → جذر المشروع)
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    candidates.push(path.resolve(here, "..", "..", "..", "dev-admin.txt"));
  } catch {
    /* ignore */
  }
  return candidates;
}

function getDevAdminPassword(): string | null {
  for (const file of devAdminFileCandidates()) {
    try {
      if (fs.existsSync(file)) {
        const content = fs.readFileSync(file, "utf8").trim();
        return content || DEV_ADMIN_DEFAULT_PASSWORD;
      }
    } catch {
      /* نتجاهل أي خطأ قراءة ونجرّب المسار التالي */
    }
  }
  return null;
}

function getAdminPasswords(): string[] {
  // مهم (أمان): قبل كان فيه كلمتي مرور مكتوبين مباشرة فـ الكود
  // ("adminkemo989" و "ik3mo2024"). هذا خطير لأن أي حد يوصل للكود المصدري
  // (مثلاً عبر GitHub public repo أو نسخة مسربة) يقدر يدخل كأدمن فوراً بلا
  // ما يحتاج يعرف أي سر حقيقي. دابا كلمة المرور تجي فقط من متغيرات البيئة
  // (ADMIN_PASSWORD) — لازم تحطها فـ إعدادات Render (Environment Variables).
  const values = [
    process.env.ADMIN_PASSWORD,
    getDevAdminPassword(), // الأدمن التجريبي المتحكَّم فيه بالملف (null لو الملف محذوف) — يشتغل غير محلياً
  ].filter((value): value is string => Boolean(value));
  return [...new Set(values)];
}

function broadcast() {
  const msg = `data: ${JSON.stringify(state)}\n\n`;
  for (const client of clients) {
    try {
      client.write(msg);
    } catch {
      clients.delete(client);
    }
  }
}

// كود عشوائي قصير لتسجيل دخول المساعدين (بدل كلمة مرور الأدمن الرئيسي)
function generateHelperCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // بدون أحرف/أرقام متشابهة (0/O, 1/I..)
  let out = "";
  for (let i = 0; i < 8; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// requireAdmin دابا يتحقق من كلمة مرور الأدمن الرئيسي أو من كود مساعد صالح فـ
// قاعدة البيانات، ويحط معلومات الدور والصلاحيات على req.adminAuth عشان باقي
// الميدلوير (requireFullAdmin / requirePermission) يستخدموها.
async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers.authorization;
  const token = auth?.replace("Bearer ", "");
  if (!token) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const adminPasswords = getAdminPasswords();
  if (adminPasswords.includes(token)) {
    (req as any).adminAuth = { role: "admin", permissions: { tournament: true, records: true } };
    next();
    return;
  }
  try {
    const helper = await dbFindHelperByCode(token);
    if (helper) {
      (req as any).adminAuth = { role: "helper", permissions: helper.permissions || {} };
      next();
      return;
    }
  } catch (err) {
    logger.error({ err }, "Failed to verify helper code");
  }
  res.status(401).json({ error: "Unauthorized" });
}

// إجراءات حساسة (حذف نهائي، إدارة المساعدين أنفسهم) — الأدمن الرئيسي فقط، حتى
// لو المساعد عنده كل الصلاحيات الأخرى.
function requireFullAdmin(req: Request, res: Response, next: NextFunction) {
  const adminAuth = (req as any).adminAuth;
  if (!adminAuth || adminAuth.role !== "admin") {
    res.status(403).json({ error: "هذا الإجراء يتطلب صلاحية الأدمن الرئيسي" });
    return;
  }
  next();
}

// إجراءات يقدر المساعد يسويها فقط لو الأدمن الرئيسي فعّلها له تحديداً.
function requirePermission(key: "tournament" | "records") {
  return (req: Request, res: Response, next: NextFunction) => {
    const adminAuth = (req as any).adminAuth;
    if (!adminAuth || (adminAuth.role !== "admin" && !adminAuth.permissions?.[key])) {
      res.status(403).json({ error: "ليس لديك صلاحية لهذا الإجراء" });
      return;
    }
    next();
  };
}

router.get("/events", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  clients.add(res);
  logger.info({ clientCount: clients.size }, "SSE client connected");

  res.write(`data: ${JSON.stringify(state)}\n\n`);

  const keepAlive = setInterval(() => {
    try {
      res.write(": keep-alive\n\n");
    } catch {
      clearInterval(keepAlive);
      clients.delete(res);
    }
  }, 20000);

  req.on("close", () => {
    clearInterval(keepAlive);
    clients.delete(res);
    logger.info({ clientCount: clients.size }, "SSE client disconnected");
  });
});

router.get("/state", async (_req: Request, res: Response) => {
  try {
    res.json(state);
  } catch (err) {
    logger.error({ err }, 'Error in GET /state');
    res.status(500).json({ error: 'Failed to get state' });
  }
});

router.post("/state", requireAdmin, requirePermission("tournament"), async (req: Request, res: Response) => {
  const incoming = req.body as TournamentState;
  const normalizedHistory = Array.isArray(incoming.winnerHistory)
    ? incoming.winnerHistory
    : [];
  state = { ...incoming, winnerHistory: normalizedHistory, updatedAt: Date.now() };

  // ✅ نبث الحالة الجديدة فوراً لجميع المشاهدين (SSE) بمجرد تحديثها بالذاكرة.
  // هذا هو سبب مشكلة "ابدأ البطولة" اللي تحتاج Refresh: كان البث ينتظر
  // اكتمال الحفظ بقاعدة البيانات أولاً (عبر await)، وقاعدة البيانات تستخدم
  // pg_advisory_xact_lock (قفل transaction) اللي ممكن يتأخر أو يفشل مؤقتاً
  // (مثلاً cold start على Render)، فيتأخر أو يضيع البث بينما الحالة
  // بالذاكرة محدّثة فعلاً — ولذلك الـ Refresh كان يظهرها فوراً (يقرأ الذاكرة
  // مباشرة) بينما المشاهدين المتصلين عبر SSE ما يوصلهم شي.
  broadcast();

  // نحفظ بقاعدة البيانات بالتوازي — لا نوقف بث المشاهدين لأجله.
  // لو فشل الحفظ، المشاهدون شافوا التحديث أصلاً (تجربة حية صحيحة)،
  // ونبلّغ الأدمن بخطأ الحفظ فقط عشان يعيد المحاولة إذا احتاج.
  try {
    await saveTournamentState(state);
  } catch (err: any) {
    logger.error({ err }, 'Failed to persist state (viewers already updated live)');
    res.status(500).json({ ok: false, error: 'Failed to save state to DB', broadcasted: true });
    return;
  }
  res.json({ ok: true });
});

// Winners endpoints
router.get("/winners", async (_req: Request, res: Response) => {
  try {
    const winners = await dbGetWinners();
    res.json(winners || []);
  } catch (err) {
    logger.error({ err }, "Failed to fetch winners");
    res.json([]);
  }
});

router.post("/winners", requireAdmin, requirePermission("tournament"), async (req: Request, res: Response) => {
  try {
    const payload = req.body as Partial<Winner>;
    const w = {
      name: payload.name || "",
      gameType: payload.gameType || "",
      tournamentName: payload.tournamentName || "",
      date: payload.date || new Date().toISOString(),
    };
    await dbAddWinner(w);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Failed to add winner");
    res.status(500).json({ error: "Failed to add winner" });
  }
});

// Tournament records endpoints — سجل بطولات يضيفه الأدمن يدوياً (اسم البطولة + الفائز + صورة)
// يظهر للمشاهدين بصفحة العرض. نستدعي broadcast() بعد أي تعديل عشان المشاهدين يحدّثون فوراً.
router.get("/records", async (_req: Request, res: Response) => {
  try {
    const records = await dbGetRecords();
    res.json(records || []);
  } catch (err) {
    logger.error({ err }, "Failed to fetch records");
    res.json([]);
  }
});

// حد أقصى لحجم الصورة (Base64) المخزّنة فـ سجل واحد — 3 ميغا كحد أقصى.
// حتى لو الواجهة (Frontend) دايماً تصغّر الصورة قبل الإرسال، هذا الحد يحمينا
// لو جا طلب مباشر للـ API (بدون مرور من الواجهة) بصورة ضخمة، وبالتالي يحمي
// حجم قاعدة البيانات من الانتفاخ المفاجئ.
const MAX_RECORD_IMAGE_CHARS = 3 * 1024 * 1024;

// 📤 رفع صورة للتخزين الخارجي (Cloudinary) — يرجّع رابط عام (URL) بدل ما نخزّن
// Base64 كامل بقاعدة البيانات. الفرونت إند يستدعي هذا أول، وبعدين يحفظ الرابط
// الراجع منه بـ /records (بدل الصورة نفسها).
router.post("/upload", requireAdmin, requirePermission("records"), async (req: Request, res: Response) => {
  try {
    const { image, folder } = req.body as { image?: string; folder?: string };
    if (!image) {
      res.status(400).json({ error: "الصورة مطلوبة" });
      return;
    }
    if (image.length > MAX_RECORD_IMAGE_CHARS) {
      res.status(413).json({ error: "حجم الصورة كبير بزاف، جرّب صورة أصغر" });
      return;
    }
    const url = await uploadImageToCloudinary(image, folder || "kemo/records");
    res.json({ url });
  } catch (err: any) {
    logger.error({ err }, "Failed to upload image");
    res.status(500).json({ error: err?.message || "فشل رفع الصورة" });
  }
});

// 📊 حالة مساحات التخزين (قاعدة البيانات + Cloudinary) — يُستخدم بشريط الحالة
// بلوحة الأدمن عشان يعرف هل كل شي شغّال، وكم نسبة الاستهلاك من الباقة المجانية.
router.get("/storage/status", requireAdmin, async (_req: Request, res: Response) => {
  const dbStatus = await (async () => {
    if (dbUsesLocalStore) {
      return { name: "database" as const, mode: "local-file" as const, ok: true, usedPercent: null };
    }
    try {
      await getTournamentState();
      return { name: "database" as const, mode: "postgres" as const, ok: true, usedPercent: null };
    } catch (err) {
      logger.error({ err }, "DB status check failed");
      return { name: "database" as const, mode: "postgres" as const, ok: false, usedPercent: null };
    }
  })();
  const cloudinaryStatus = await getCloudinaryStatus();
  res.json({ database: dbStatus, cloudinary: cloudinaryStatus });
});

// 🔁 نقل الصور القديمة المخزّنة Base64 داخل قاعدة البيانات (سجل البطولات) إلى
// التخزين الخارجي (Cloudinary) — يشتغل مرة وحدة عند الطلب من لوحة الأدمن، ويعيد
// كتابة كل سجل قديم برابط بدل الصورة الكاملة، فيخفف حجم القاعدة تدريجياً.
// 📜 سجل صور الكروت: كل الصور المرفوعة لـ Cloudinary مع تاريخ رفعها.
router.get("/images/history", requireAdmin, requirePermission("records"), async (_req: Request, res: Response) => {
  if (!isCloudinaryConfigured) {
    res.status(400).json({ error: "Cloudinary غير مهيّأ" });
    return;
  }
  try {
    const images = await listCloudinaryImages("kemo/records", 300);
    res.json(images);
  } catch (err: any) {
    logger.error({ err }, "Failed to list cloudinary images");
    res.status(500).json({ error: err?.message || "فشل جلب سجل الصور" });
  }
});

// 🗑️ حذف صورة من مكتبة Cloudinary. لو كانت مستخدمة بكرت، ننظّف الحقل كمان
// عشان ما يبقى الكرت مؤشراً على رابط ميت.
router.post("/images/delete", requireAdmin, requirePermission("records"), async (req: Request, res: Response) => {
  const { publicId, url } = req.body as { publicId?: string; url?: string };
  if (!publicId) {
    res.status(400).json({ error: "معرّف الصورة مطلوب" });
    return;
  }
  if (!isCloudinaryConfigured) {
    res.status(400).json({ error: "Cloudinary غير مهيّأ" });
    return;
  }
  try {
    await deleteCloudinaryImage(publicId);
    if (url) {
      const records = await dbGetRecords();
      for (const rec of records) {
        if (rec.image === url || rec.image2 === url) {
          await dbUpsertRecord({
            tournamentName: rec.tournamentName,
            winnerName: rec.winnerName,
            image: rec.image === url ? "" : rec.image,
            image2: rec.image2 === url ? "" : rec.image2,
          });
        }
      }
      broadcast();
    }
    res.json({ ok: true });
  } catch (err: any) {
    logger.error({ err, publicId }, "Failed to delete image");
    res.status(500).json({ error: err?.message || "فشل حذف الصورة" });
  }
});

// 📜 سجل كروت البطولات — لقطات تاريخية مرتّبة من الأحدث.
router.get("/records/history", requireAdmin, requirePermission("records"), async (req: Request, res: Response) => {
  try {
    const limit = Number(req.query.limit) || 300;
    res.json(await dbGetRecordHistory(limit));
  } catch (err: any) {
    logger.error({ err }, "Failed to fetch record history");
    res.status(500).json({ error: err?.message || "فشل جلب السجل" });
  }
});

// 🗑️ حذف لقطة من السجل (ما تمس الكرت ولا الصورة بـ Cloudinary).
router.post("/records/history/delete", requireAdmin, requirePermission("records"), async (req: Request, res: Response) => {
  const { id } = req.body as { id?: number };
  if (!id) {
    res.status(400).json({ error: "معرّف السطر مطلوب" });
    return;
  }
  try {
    await dbDeleteRecordHistory(Number(id));
    res.json({ ok: true });
  } catch (err: any) {
    logger.error({ err }, "Failed to delete record history");
    res.status(500).json({ error: err?.message || "فشل الحذف" });
  }
});

router.post("/migrate-images", requireAdmin, requirePermission("records"), async (_req: Request, res: Response) => {
  if (!isCloudinaryConfigured) {
    res.status(400).json({ error: "Cloudinary غير مهيّأ — أضف متغيرات البيئة أولاً" });
    return;
  }
  const isBase64Image = (v: string) => typeof v === "string" && v.startsWith("data:");
  let migrated = 0;
  let failed = 0;
  let skipped = 0;
  try {
    const records = await dbGetRecords();
    for (const rec of records) {
      const needsImage = isBase64Image(rec.image);
      const needsImage2 = isBase64Image(rec.image2);
      if (!needsImage && !needsImage2) { skipped++; continue; }
      try {
        const patch: Record<string, string> = { tournamentName: rec.tournamentName, winnerName: rec.winnerName };
        if (needsImage) patch.image = await uploadImageToCloudinary(rec.image, "kemo/records");
        if (needsImage2) patch.image2 = await uploadImageToCloudinary(rec.image2, "kemo/records");
        await dbUpsertRecord(patch);
        migrated++;
      } catch (err) {
        logger.error({ err, record: rec.tournamentName }, "Failed to migrate record image");
        failed++;
      }
    }
    res.json({ migrated, skipped, failed, total: records.length });
  } catch (err: any) {
    logger.error({ err }, "Image migration failed");
    res.status(500).json({ error: err?.message || "فشل نقل الصور" });
  }
});

// النظام الجديد: الأدمن يعدّل صورة لعبة (بدل ما يضيف بطولة). المفتاح هو اسم اللعبة
// (tournamentName)، فلكل لعبة سجل واحد نحدّث صورته أو ننشئه لو ما كان موجود.
router.put("/records", requireAdmin, requirePermission("records"), async (req: Request, res: Response) => {
  try {
    const payload = req.body as { tournamentName?: string; displayName?: string; winnerName?: string; image?: string; image2?: string };
    const tournamentName = (payload.tournamentName || "").trim();
    const winnerName = (payload.winnerName || "").trim();
    const image = payload.image || "";
    // displayName و image2 اختياريان: لو ما جاو فـ الطلب نخليهم undefined عشان ما نمسحش القيمة المحفوظة سابقاً.
    const displayName = payload.displayName !== undefined ? payload.displayName.trim() : undefined;
    const image2 = payload.image2 !== undefined ? payload.image2 : undefined;
    if (!tournamentName) {
      res.status(400).json({ error: "اسم اللعبة مطلوب" });
      return;
    }
    if (image.length > MAX_RECORD_IMAGE_CHARS || (image2 !== undefined && image2.length > MAX_RECORD_IMAGE_CHARS)) {
      res.status(413).json({ error: "حجم الصورة كبير بزاف، جرّب صورة أصغر" });
      return;
    }

    // 🏅 قبل الحفظ: نجيب اسم الفائز القديم لهذي اللعبة عشان نعرف هل تغيّر الفائز.
    // الاحتساب التلقائي: كل ما يتحدد فائز جديد (اسم غير فاضي ومختلف عن السابق)
    // نزيد فوز واحد لذاك اللاعب في هذي اللعبة (أساس اللفل وشريط التقدّم).
    // تعديل الصورة/الاسم المعروض بدون تغيير الفائز ما يزيد أي فوز (يمنع التكرار).
    let oldWinner = "";
    try {
      const existingRecords = await dbGetRecords();
      const match = (existingRecords || []).find((r: any) => r.tournamentName === tournamentName);
      oldWinner = (match?.winnerName || "").trim();
    } catch { /* لو فشل الجلب نكمل بدون احتساب (الحفظ أهم) */ }

    const result = await dbUpsertRecord({ tournamentName, displayName, winnerName, image, image2 });
    const row = Array.isArray(result) ? result[0] : result;

    if (winnerName && dbNormalizePlayerName(winnerName) !== dbNormalizePlayerName(oldWinner)) {
      try {
        await dbIncrementPlayerWin(winnerName, winnerName, tournamentName, 1);
      } catch (winErr) {
        logger.error({ err: winErr }, "Failed to increment player win");
      }
    }

    // 📜 لقطة للسجل التاريخي: اللعبة + الفائز + الصورة + وقت الحفظ.
    // تُكتب هنا (بالخادم) فتشمل أي مصدر حفظ، وتتجاهل التكرار لو ما تغيّر شي.
    try {
      await dbAddRecordHistory({
        tournamentName,
        displayName: displayName ?? row?.displayName ?? "",
        winnerName,
        image,
      });
    } catch (hErr) {
      logger.error({ err: hErr }, "Failed to append record history");
    }

    broadcast(); // ننبّه المشاهدين عشان يعيدون جلب السجل
    res.json(row);
  } catch (err) {
    logger.error({ err }, "Failed to save record");
    res.status(500).json({ error: "فشل حفظ السجل" });
  }
});

router.delete("/records/:id", requireAdmin, requireFullAdmin, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "رقم غير صالح" });
      return;
    }
    await dbDeleteRecord(id);
    broadcast(); // ننبّه المشاهدين عشان يعيدون جلب السجل
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Failed to delete record");
    res.status(500).json({ error: "فشل حذف السجل" });
  }
});

// إخفاء/إظهار كرت فائز من الصفحة العامة بدون حذف بياناته — الأدمن يقدر يرجّعه بأي وقت.
router.patch("/records/:id/visibility", requireAdmin, requirePermission("records"), async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "رقم غير صالح" });
      return;
    }
    const isHidden = Boolean((req.body as { isHidden?: boolean })?.isHidden);
    const result = await dbSetRecordVisibility(id, isHidden);
    const row = Array.isArray(result) ? result[0] : result;
    // 📜 لقطة للسجل التاريخي: اللعبة + الفائز + الصورة + وقت الحفظ.
    // تُكتب هنا (بالخادم) فتشمل أي مصدر حفظ، وتتجاهل التكرار لو ما تغيّر شي.
    try {
      await dbAddRecordHistory({
        tournamentName,
        displayName: displayName ?? row?.displayName ?? "",
        winnerName,
        image,
      });
    } catch (hErr) {
      logger.error({ err: hErr }, "Failed to append record history");
    }

    broadcast(); // ننبّه المشاهدين عشان يعيدون جلب السجل
    res.json(row);
  } catch (err) {
    logger.error({ err }, "Failed to toggle record visibility");
    res.status(500).json({ error: "فشل تغيير حالة الظهور" });
  }
});

// ==========================================
// إحصائيات اللاعبين (Player Stats) — فوزات + لفل لكل لعبة
// ==========================================
// GET عام (بدون توكن): يرجّع فوزات لاعب معيّن لكل لعبة. يستخدمه:
//  - الزائر المسجّل بالصفحة العامة عشان يشوف لفله وشريط تقدّمه تحت كل كرت.
//  - الأدمن عشان يكتب اسم حساب ويشوف فوزاته ولفله.
router.get("/player/stats", async (req: Request, res: Response) => {
  try {
    const username = String(req.query.username || "").trim();
    if (!username) {
      res.status(400).json({ error: "اسم الحساب مطلوب" });
      return;
    }
    const rows = await dbGetPlayerWins(username);
    const wins: Record<string, number> = {};
    let displayName = username;
    for (const r of rows || []) {
      wins[r.game] = r.wins || 0;
      if (r.displayName) displayName = r.displayName;
    }
    res.json({ username: displayName, wins });
  } catch (err) {
    logger.error({ err }, "Failed to fetch player stats");
    res.json({ username: String(req.query.username || ""), wins: {} });
  }
});

// 🏆 قائمة المتصدّرين (عام، بدون توكن): أعلى اللاعبين حسب مجموع فوزاتهم عبر
// كل الألعاب. تستخدمه القائمة المنبثقة تحت أيقونة الكأس بالصفحة العامة.
// 📊 قائمة نظام المستويات — كل اللاعبين ومجموع فوزاتهم من player_wins.
// عامة للقراءة زي /player/stats و /player/leaderboard.
//
// 🩹 خطة احتياطية مهمة: لو نسخة @workspace/db المنشورة قديمة وما فيها
// getPlayerLevels، نحسب التجميع هنا مباشرة من جدول player_wins بدل ما نفشل.
// (بدونها كان النداء يرمي TypeError → 500 → تطلع القائمة فاضية بلوحة الأدمن
// رغم إن الفوزات موجودة فعلاً وتظهر بشريط اللفل تحت الكروت بالصفحة العامة.)
async function computePlayerLevels(limit: number) {
  const n = Math.max(1, Math.min(2000, Math.floor(Number(limit) || 500)));
  if (typeof dbGetPlayerLevels === "function") return await dbGetPlayerLevels(n);

  logger.warn("getPlayerLevels مفقودة من @workspace/db — نستعمل الحساب الاحتياطي داخل المسار");
  if (dbUsesLocalStore) {
    throw new Error("getPlayerLevels مفقودة من حزمة قاعدة البيانات (وضع التخزين المحلي) — حدّث lib/db/src/index.ts");
  }
  const table = dbSchemaModule?.playerWinsTable;
  if (!dbModule?.db || !table) {
    throw new Error("تعذّر الوصول لجدول player_wins — حدّث lib/db/src/index.ts");
  }
  const rows = await dbModule.db.select().from(table);
  const totals = new Map<string, { username: string; displayName: string; wins: number }>();
  for (const r of rows || []) {
    const key = String(r.username || "").trim();
    if (!key) continue;
    const cur = totals.get(key) || { username: key, displayName: "", wins: 0 };
    cur.wins += Number(r.wins) || 0;
    if (!cur.displayName && r.displayName) cur.displayName = String(r.displayName).trim();
    totals.set(key, cur);
  }
  return [...totals.values()]
    .filter((p) => p.wins > 0)
    .sort((a, b) => b.wins - a.wins || a.username.localeCompare(b.username))
    .slice(0, n)
    .map((p) => ({ username: p.displayName || p.username, wins: p.wins }));
}

router.get("/player/levels", async (req: Request, res: Response) => {
  try {
    const rows = await computePlayerLevels(Number(req.query.limit) || 500);
    res.json(rows || []);
  } catch (err) {
    logger.error({ err }, "Failed to fetch player levels");
    // نرجّع سبب العطل الحقيقي مع الرد عشان لوحة الأدمن تعرضه بدل رسالة عامة
    // ما تدل على شي — كذا يبان فوراً وش الناقص بدل التخمين.
    res.status(500).json({
      error: "فشل جلب قائمة المستويات",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

// 🧹 تصفير نظام المستويات لكل اللاعبين (بداية موسم جديد).
// مستقل عن /player/match-wins/reset: هذا يمسح player_wins (لفل الكروت)،
// وذاك يمسح player_match_wins (نقاط الأكثر انتصاراً).
// نفس فكرة الخطة الاحتياطية فوق: يشتغل حتى لو resetAllPlayerWins مو موجودة.
router.post("/player/wins/reset", requireAdmin, requirePermission("records"), async (_req: Request, res: Response) => {
  try {
    if (typeof dbResetAllPlayerWins === "function") {
      const out = await dbResetAllPlayerWins();
      broadcast();
      res.json(out || { cleared: 0 });
      return;
    }
    const table = dbSchemaModule?.playerWinsTable;
    if (dbUsesLocalStore || !dbModule?.db || !table) {
      throw new Error("resetAllPlayerWins مفقودة من حزمة قاعدة البيانات — حدّث lib/db/src/index.ts");
    }
    const rows = await dbModule.db.select().from(table);
    const players = new Set(
      (rows || []).filter((r: any) => (Number(r.wins) || 0) > 0).map((r: any) => String(r.username)),
    );
    await dbModule.db.delete(table);
    broadcast();
    res.json({ cleared: players.size });
  } catch (err) {
    logger.error({ err }, "Failed to reset player wins");
    res.status(500).json({
      error: "فشل تصفير المستويات",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

// 🩹 خطة احتياطية لنقاط "الأكثر انتصاراً" — نفس فكرة computePlayerLevels فوق:
// لو getLeaderboard مفقودة من نسخة @workspace/db المنشورة، نقرأ الجدول مباشرة
// بدل ما نفشل ونرجّع قائمة فاضية.
async function computeLeaderboard(limit: number) {
  const n = Math.min(50, Math.max(1, Math.floor(Number(limit) || 3)));
  if (typeof dbGetLeaderboard === "function") return await dbGetLeaderboard(n);

  logger.warn("getLeaderboard مفقودة من @workspace/db — نستعمل الحساب الاحتياطي داخل المسار");
  if (dbUsesLocalStore) {
    throw new Error("getLeaderboard مفقودة من حزمة قاعدة البيانات (وضع التخزين المحلي) — حدّث lib/db/src/index.ts");
  }
  const table = dbSchemaModule?.playerMatchWinsTable;
  if (!dbModule?.db || !table) {
    throw new Error("تعذّر الوصول لجدول player_match_wins — حدّث lib/db/src/index.ts");
  }
  const rows = await dbModule.db.select().from(table);
  return (rows || [])
    .map((r: any) => ({
      username: (r.displayName && String(r.displayName).trim()) || String(r.username || ""),
      wins: Number(r.wins) || 0,
    }))
    .filter((r: any) => r.username && r.wins > 0)
    .sort((a: any, b: any) => b.wins - a.wins || a.username.localeCompare(b.username))
    .slice(0, n);
}

// 🐞 قبل كذا كان هذا المسار يبلع أي خطأ ويرجّع [] بحالة 200، فلوحة الأدمن
// تعرض "ما فيه نقاط مسجّلة بعد" حتى لو السبب عطل حقيقي بقاعدة البيانات
// (مثلاً relation "player_match_wins" does not exist). صار يرجّع 500 + سبب
// واضح — نفس أسلوب /player/levels.
router.get("/player/leaderboard", async (req: Request, res: Response) => {
  try {
    const limit = Math.min(50, Math.max(1, Math.floor(Number(req.query.limit) || 3)));
    const rows = await computeLeaderboard(limit);
    res.json(rows || []);
  } catch (err) {
    logger.error({ err }, "Failed to fetch leaderboard");
    res.status(500).json({
      error: "فشل جلب نقاط الأكثر انتصاراً",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

// 🏆 تسجيل فوز ماتش: يُستدعى من صفحة الأدمن كل ما يُحسم ماتش داخل البطولة.
// delta = +1 عند كسب الماتش، -1 عند التراجع عن النتيجة. محصور في [-1, +1]
// عشان ما يقدر أحد ينفخ الرقم بطلب واحد. هذا العدّاد مستقل عن /player/wins:
// ذاك يخص لفل الكروت (بطولات مكسوبة)، وهذا يخص توب الفائزين (ماتشات مكسوبة).
router.post("/player/match-win", requireAdmin, requirePermission("tournament"), async (req: Request, res: Response) => {
  try {
    const { username, delta } = req.body as { username?: string; delta?: number };
    const name = (username || "").trim();
    if (!name) {
      res.status(400).json({ error: "اسم اللاعب مطلوب" });
      return;
    }
    // 🚫 نظام الفرق ما يسجّل نقاط توب إطلاقاً.
    // الحارس هنا بالخادم مو بالواجهة فقط: كذا لو نسخة قديمة من صفحة الأدمن
    // لسا شغالة بمتصفح أحد، أو جا الطلب من أي مصدر ثاني، ما ينحسب.
    // "الخانة" بوضع الفرق تحتوي فريق كامل ("سعود N فهد") فتسجيلها يخرّب
    // القائمة بأسماء فرق مدموجة بدل أسماء لاعبين.
    const current = await getTournamentState();
    if (current && (current as any).isTeams) {
      res.json({ skipped: true, reason: "teams-mode" });
      return;
    }

    const raw = Math.trunc(Number(delta ?? 1));
    const d = Number.isFinite(raw) && raw !== 0 ? Math.max(-1, Math.min(1, raw)) : 1;
    const row = await dbIncrementPlayerMatchWin(name, name, d);
    broadcast(); // عشان تتحدث قائمة التوب لحظياً عند كل المشاهدين
    res.json(row);
  } catch (err) {
    logger.error({ err }, "Failed to record match win");
    res.status(500).json({
      error: "فشل تسجيل فوز الماتش",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

// ✍️ تحكم يدوي بنقاط التوب: يحدد قيمة صريحة لنقاط لاعب (بدل حصر ±1).
// صلاحية "records" لأنها تعديل على السجلات مو على مجرى البطولة.
router.post("/player/match-wins", requireAdmin, requirePermission("records"), async (req: Request, res: Response) => {
  try {
    const { username, wins } = req.body as { username?: string; wins?: number };
    const name = (username || "").trim();
    if (!name) {
      res.status(400).json({ error: "اسم اللاعب مطلوب" });
      return;
    }
    const value = Math.max(0, Math.min(100000, Math.floor(Number(wins) || 0)));
    const row = await dbSetPlayerMatchWins(name, name, value);
    broadcast(); // تتحدّث قائمة التوب لحظياً عند كل المشاهدين
    res.json(row);
  } catch (err) {
    logger.error({ err }, "Failed to set match wins");
    res.status(500).json({
      error: "فشل تعديل النقاط",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

// 🧹 تصفير نقاط التوب لكل اللاعبين (بداية موسم جديد).
router.post("/player/match-wins/reset", requireAdmin, requirePermission("records"), async (_req: Request, res: Response) => {
  try {
    const out = await dbResetAllPlayerMatchWins();
    broadcast();
    res.json(out || { cleared: 0 });
  } catch (err) {
    logger.error({ err }, "Failed to reset match wins");
    res.status(500).json({
      error: "فشل تصفير النقاط",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

// تعديل يدوي لفوزات لاعب في لعبة معيّنة (تصحيح من الأدمن) — يحدد قيمة صريحة.
router.post("/player/wins", requireAdmin, requirePermission("records"), async (req: Request, res: Response) => {
  try {
    const { username, game, wins } = req.body as { username?: string; game?: string; wins?: number };
    const name = (username || "").trim();
    const g = (game || "").trim();
    if (!name || !g) {
      res.status(400).json({ error: "اسم الحساب واللعبة مطلوبان" });
      return;
    }
    const row = await dbSetPlayerWins(name, name, g, Math.max(0, Math.floor(Number(wins) || 0)));
    broadcast(); // عشان تتحدث الإحصائيات لحظياً عند المسجّلين
    res.json(row);
  } catch (err) {
    logger.error({ err }, "Failed to set player wins");
    res.status(500).json({ error: "فشل تحديث الفوزات" });
  }
});

// Archive endpoints — full saved tournament tables (all rounds), so admin can go back and review them
router.get("/archives", async (_req: Request, res: Response) => {
  try {
    const archives = await dbGetArchives();
    res.json(archives || []);
  } catch (err) {
    logger.error({ err }, "Failed to fetch archives");
    res.json([]);
  }
});

router.get("/archives/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const archive = await dbGetArchiveById(id);
    if (!archive) {
      res.status(404).json({ error: "غير موجود" });
      return;
    }
    res.json(archive);
  } catch (err) {
    logger.error({ err }, "Failed to fetch archive");
    res.status(500).json({ error: "فشل جلب الأرشيف" });
  }
});

router.post("/archives", requireAdmin, requirePermission("tournament"), async (req: Request, res: Response) => {
  try {
    const payload = req.body;
    const archive = {
      name: payload.name || "",
      gameType: payload.gameType || "",
      champion: payload.champion || "",
      isTeams: payload.isTeams || false,
      teamSize: payload.teamSize || 2,
      players: payload.players || [],
      rounds: payload.rounds || [],
      finishedAt: payload.finishedAt || new Date().toISOString(),
    };
    const result = await dbAddArchive(archive);
    const row = Array.isArray(result) ? result[0] : result;
    broadcast();
    res.json(row);
  } catch (err) {
    logger.error({ err }, "Failed to add archive");
    res.status(500).json({ error: "فشل حفظ الأرشيف" });
  }
});

router.post("/admin/login", (req: Request, res: Response) => {
  const { password } = req.body as { password: string };
  const adminPasswords = getAdminPasswords();
  const matchedPassword = adminPasswords.find((value) => value === password);
  if (matchedPassword) {
    res.json({ token: matchedPassword, role: "admin", permissions: { tournament: true, records: true } });
  } else {
    res.status(401).json({ error: "كلمة المرور غير صحيحة" });
  }
});

// دخول المساعد بكود منحه له الأدمن الرئيسي (مو كلمة مرور الأدمن)
router.post("/admin/helper-login", async (req: Request, res: Response) => {
  try {
    const { code } = req.body as { code: string };
    if (!code) {
      res.status(401).json({ error: "الكود مطلوب" });
      return;
    }
    const helper = await dbFindHelperByCode(code);
    if (!helper) {
      res.status(401).json({ error: "كود غير صحيح" });
      return;
    }
    res.json({ token: helper.code, role: "helper", permissions: helper.permissions || {}, name: helper.name });
  } catch (err) {
    logger.error({ err }, "Failed helper login");
    res.status(500).json({ error: "تعذّر تسجيل الدخول" });
  }
});

// يتأكد الفرونت من صلاحية توكن محفوظ عند إعادة تحميل الصفحة (ويعرف دوره وصلاحياته)
router.get("/admin/whoami", requireAdmin, (req: Request, res: Response) => {
  const adminAuth = (req as any).adminAuth;
  res.json(adminAuth);
});

// ==========================================
// إدارة مساعدي الأدمن — الأدمن الرئيسي فقط
// ==========================================

router.get("/admin/helpers", requireAdmin, requireFullAdmin, async (_req: Request, res: Response) => {
  try {
    const helpers = await dbGetHelpers();
    res.json(helpers || []);
  } catch (err) {
    logger.error({ err }, "Failed to fetch helpers");
    res.status(500).json({ error: "فشل جلب قائمة المساعدين" });
  }
});

router.post("/admin/helpers", requireAdmin, requireFullAdmin, async (req: Request, res: Response) => {
  try {
    const { name, permissions } = req.body as { name: string; permissions: Record<string, boolean> };
    if (!name || !name.trim()) {
      res.status(400).json({ error: "اسم المساعد مطلوب" });
      return;
    }
    const code = generateHelperCode();
    const helper = await dbAddHelper({ name: name.trim(), code, permissions: permissions || {} });
    res.json(helper);
  } catch (err) {
    logger.error({ err }, "Failed to add helper");
    res.status(500).json({ error: "فشل إنشاء المساعد" });
  }
});

router.patch("/admin/helpers/:id", requireAdmin, requireFullAdmin, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { permissions } = req.body as { permissions: Record<string, boolean> };
    const updated = await dbUpdateHelperPermissions(id, permissions || {});
    if (!updated) {
      res.status(404).json({ error: "المساعد غير موجود" });
      return;
    }
    res.json(updated);
  } catch (err) {
    logger.error({ err }, "Failed to update helper");
    res.status(500).json({ error: "فشل تحديث صلاحيات المساعد" });
  }
});

router.delete("/admin/helpers/:id", requireAdmin, requireFullAdmin, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    await dbDeleteHelper(id);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Failed to delete helper");
    res.status(500).json({ error: "فشل حذف المساعد" });
  }
});

// حالة الأدمن التجريبي: هل ملف dev-admin.txt موجود؟ (يُستخدم للدخول بدون كلمة مرور على localhost)
router.get("/admin/dev-status", (_req: Request, res: Response) => {
  res.json({ enabled: getDevAdminPassword() !== null });
});

// دخول تجريبي بدون كلمة مرور: يشتغل فقط إذا كان ملف dev-admin.txt موجود
router.post("/admin/dev-login", (_req: Request, res: Response) => {
  const devPassword = getDevAdminPassword();
  if (devPassword) {
    res.json({ token: devPassword, role: "admin", permissions: { tournament: true, records: true } });
  } else {
    res.status(401).json({ error: "الأدمن التجريبي غير مفعّل (ملف dev-admin.txt غير موجود)" });
  }
});

export { BYE };
export default router;
