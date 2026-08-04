import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';
import { eq, desc, sql } from 'drizzle-orm';
import { localStore } from './local-store';

// 1. التحقق من رابط قاعدة البيانات وإعداد الاتصال
const databaseUrl = process.env.DATABASE_URL;

// وضع التشغيل: لو ما فيه DATABASE_URL نستخدم مخزّن محلي بملف JSON (localhost بدون Postgres)
// بدل ما نطفّي الخادم. هذا يخلّي المشروع يشتغل مباشرة بدون أي إعداد لقاعدة بيانات.
export const USE_LOCAL_STORE = !databaseUrl;

const pool = USE_LOCAL_STORE ? null : new Pool({ connectionString: databaseUrl });

// تهيئة Drizzle ORM (فقط في وضع قاعدة البيانات)
export const db: any = USE_LOCAL_STORE ? null : drizzle(pool!, { schema });

// ==========================================
// حدود التخزين (Storage Caps)
// ==========================================
// ملاحظة مهمة: قبل ما كنا نزيدو صفوف بلا أي حد أقصى فـ winners / archives /
// tournament_records — وبما إن tournament_records فيها صور Base64 (تقدر توصل
// لعدة مئات الـ KB للصورة الواحدة)، كان الجدول يكبر بلا توقف مع الوقت ويستهلك
// مساحة قاعدة البيانات بزاف بلا داعي (خصوصاً فـ خطط Render المجانية/المحدودة
// اللي عندها سقف تخزين صغير).
// الحل: بعد كل إضافة، نمسحو أقدم الصفوف اللي تجاوزت الحد الأقصى تلقائياً.
const MAX_WINNERS = 500;
const MAX_ARCHIVES = 150;
const MAX_RECORDS = 100;

async function pruneTable(tableName: string, maxRows: number) {
  if (USE_LOCAL_STORE || !pool) return;
  try {
    // نمسح أي صف رقمه (id) مو من ضمن أحدث maxRows صف — أبسط وأسرع طريقة
    // للحفاظ على حجم الجدول ثابت بدون ما نحسب العدد الحالي فـ كل مرة.
    await pool.query(
      `DELETE FROM ${tableName} WHERE id NOT IN (SELECT id FROM ${tableName} ORDER BY id DESC LIMIT $1)`,
      [maxRows],
    );
  } catch (error) {
    console.error(`⚠️ فشل تقليم جدول ${tableName}:`, error);
  }
}

// ==========================================
// تأكيد وجود كل الجداول (Schema Bootstrap)
// ==========================================
// ملاحظة مهمة: كنا نعتمدو على "drizzle-kit push" يدوياً/فـ build command، لكن هذا الأمر
// تفاعلي (interactive) ويحتاج يسألك أسئلة فحالات معينة، وفـ بيئة الـ CI عند Render ما كاين
// حتى terminal يرد عليه، فـ يفشل الـ build بدون سبب واضح.
// الحل: نفّذو "CREATE TABLE IF NOT EXISTS" مباشرة عند إقلاع السيرفر. هذا آمن 100%:
// - لو الجدول كاين، ما يصير والو (IF NOT EXISTS)
// - لو الجدول ناقص (مثلاً زدنا جدول جديد فـ الكود ونسينا نرفعو لقاعدة البيانات)، يتخلق تلقائياً
// - ما فيه أي تفاعل، يخدم فـ أي بيئة (Render, local, إلخ)
async function ensureSchema() {
  if (USE_LOCAL_STORE) return;
  const client = await pool!.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS tournament_state (
        id serial PRIMARY KEY,
        phase text NOT NULL DEFAULT 'setup',
        size integer NOT NULL DEFAULT 16,
        players jsonb NOT NULL DEFAULT '[]',
        rounds jsonb NOT NULL DEFAULT '[]',
        cur integer NOT NULL DEFAULT 0,
        b_size integer NOT NULL DEFAULT 16,
        bye_n integer NOT NULL DEFAULT 0,
        is_teams boolean NOT NULL DEFAULT false,
        team_size integer NOT NULL DEFAULT 2,
        name text DEFAULT '',
        game_type text DEFAULT '',
        champion text DEFAULT '',
        scheduled_at text DEFAULT '',
        last_winner text DEFAULT '',
        last_game_type text DEFAULT '',
        last_tournament_name text DEFAULT '',
        entry_log jsonb NOT NULL DEFAULT '[]',
        winner_history jsonb NOT NULL DEFAULT '[]',
        updated_at timestamp NOT NULL DEFAULT now(),
        created_at timestamp NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS winners (
        id serial PRIMARY KEY,
        name text NOT NULL,
        game_type text NOT NULL,
        tournament_name text NOT NULL,
        date timestamp NOT NULL DEFAULT now(),
        created_at timestamp NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS tournament_archives (
        id serial PRIMARY KEY,
        name text NOT NULL DEFAULT '',
        game_type text NOT NULL DEFAULT '',
        champion text NOT NULL DEFAULT '',
        is_teams boolean NOT NULL DEFAULT false,
        team_size integer NOT NULL DEFAULT 2,
        players jsonb NOT NULL DEFAULT '[]',
        rounds jsonb NOT NULL DEFAULT '[]',
        finished_at timestamp NOT NULL DEFAULT now(),
        created_at timestamp NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS tournament_records (
        id serial PRIMARY KEY,
        tournament_name text NOT NULL DEFAULT '',
        display_name text NOT NULL DEFAULT '',
        winner_name text NOT NULL DEFAULT '',
        image text NOT NULL DEFAULT '',
        image2 text NOT NULL DEFAULT '',
        created_at timestamp NOT NULL DEFAULT now()
      );

      -- للجداول القديمة اللي اتخلقت قبل ما نضيفو display_name/image2: نضيفو العمود لو ناقص.
      ALTER TABLE tournament_records ADD COLUMN IF NOT EXISTS display_name text NOT NULL DEFAULT '';
      -- عمود إخفاء/إظهار الكرت من الصفحة العامة (بدون حذف بياناته)
      ALTER TABLE tournament_records ADD COLUMN IF NOT EXISTS is_hidden boolean NOT NULL DEFAULT false;
      ALTER TABLE tournament_records ADD COLUMN IF NOT EXISTS image2 text NOT NULL DEFAULT '';

      CREATE TABLE IF NOT EXISTS admin_helpers (
        id serial PRIMARY KEY,
        name text NOT NULL,
        code text NOT NULL UNIQUE,
        permissions jsonb NOT NULL DEFAULT '{}',
        created_at timestamp NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS player_wins (
        id serial PRIMARY KEY,
        username text NOT NULL,
        display_name text NOT NULL DEFAULT '',
        game text NOT NULL,
        wins integer NOT NULL DEFAULT 0,
        updated_at timestamp NOT NULL DEFAULT now(),
        created_at timestamp NOT NULL DEFAULT now()
      );
      -- مفتاح فريد على (اللاعب المطبَّع + اللعبة) عشان ما يتكرّر نفس اللاعب لنفس اللعبة.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_player_wins_user_game ON player_wins (username, game);

      -- 🏆 نقاط "الأكثر انتصاراً" (ماتشات مكسوبة) — جدول مستقل تماماً عن player_wins.
      -- 🐞 هذا الجدول كان ناقصاً من ensureSchema رغم إنه معرّف بـ schema/tournaments.ts
      -- ومستعمل بـ getLeaderboard / incrementPlayerMatchWin / setPlayerMatchWins.
      -- النتيجة على Postgres: كل استعلام عليه يرمي
      -- relation "player_match_wins" does not exist، ومسار /player/leaderboard
      -- كان يبلع الخطأ ويرجّع [] → قائمة "نقاط الأكثر انتصاراً" بلوحة الأدمن تطلع
      -- فاضية دايماً، وتسجيل النقاط عند كسب أي ماتش ما يشتغل أصلاً.
      -- (بالتخزين المحلي كان يشتغل عادي، عشان كذا المشكلة تبان بالنشر فقط.)
      CREATE TABLE IF NOT EXISTS player_match_wins (
        id serial PRIMARY KEY,
        username text NOT NULL,
        display_name text NOT NULL DEFAULT '',
        wins integer NOT NULL DEFAULT 0,
        updated_at timestamp NOT NULL DEFAULT now(),
        created_at timestamp NOT NULL DEFAULT now()
      );
      -- للجداول اللي اتخلقت بنسخة أقدم وناقصها أعمدة
      ALTER TABLE player_match_wins ADD COLUMN IF NOT EXISTS display_name text NOT NULL DEFAULT '';
      ALTER TABLE player_match_wins ADD COLUMN IF NOT EXISTS wins integer NOT NULL DEFAULT 0;
      ALTER TABLE player_match_wins ADD COLUMN IF NOT EXISTS updated_at timestamp NOT NULL DEFAULT now();
      ALTER TABLE player_match_wins ADD COLUMN IF NOT EXISTS created_at timestamp NOT NULL DEFAULT now();

      -- 📜 سجل تاريخي لكروت البطولات: لقطة تُحفظ عند كل تغيير صورة أو فائز،
      -- عشان يبقى تاريخ كل بطولة محفوظاً حتى لو تغيّر الكرت لاحقاً.
      CREATE TABLE IF NOT EXISTS record_history (
        id serial PRIMARY KEY,
        tournament_name text NOT NULL,
        display_name text NOT NULL DEFAULT '',
        winner_name text NOT NULL DEFAULT '',
        image text NOT NULL DEFAULT '',
        saved_at timestamp NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_record_history_saved_at ON record_history (saved_at DESC);

      CREATE INDEX IF NOT EXISTS idx_winners_date ON winners (date DESC);
      CREATE INDEX IF NOT EXISTS idx_archives_finished_at ON tournament_archives (finished_at DESC);
      CREATE INDEX IF NOT EXISTS idx_records_created_at ON tournament_records (created_at DESC);
    `);

    // 🔑 مفتاح username الفريد بـ player_match_wins — منفصل عن الاستعلام فوق عن قصد:
    // لو الجدول كان موجود من نشرة قديمة وفيه أسماء مكرّرة، إنشاء الفهرس يفشل ويطيّح
    // كل ensureSchema معاه. فهنا ندمج المكرّر أولاً (نجمع نقاطه بصف واحد) وبعدها
    // ننشئ الفهرس، وأي فشل هنا ما يمنع بقية الجداول من الاشتغال.
    try {
      await client.query(`
        WITH ranked AS (
          SELECT id, username, SUM(wins) OVER (PARTITION BY username) AS total,
                 ROW_NUMBER() OVER (PARTITION BY username ORDER BY id ASC) AS rn
            FROM player_match_wins
        )
        UPDATE player_match_wins p
           SET wins = r.total
          FROM ranked r
         WHERE p.id = r.id AND r.rn = 1 AND p.wins <> r.total;
      `);
      await client.query(`
        DELETE FROM player_match_wins a
         USING player_match_wins b
         WHERE a.username = b.username AND a.id > b.id;
      `);
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_player_match_wins_user ON player_match_wins (username);`,
      );
    } catch (error) {
      console.error("⚠️ تعذّر ضبط مفتاح player_match_wins الفريد:", error);
    }

    console.log("✅ تم التأكد من وجود كل الجداول فـ قاعدة البيانات (schema sync)");
  } catch (error) {
    // ⚠️ فشل هنا يعني جدول ناقص → مسارات كاملة ترجع فاضية بدون سبب واضح
    // (نفس اللي صار مع player_match_wins). ما نطيّح الإقلاع، بس نصرخ باللوق.
    console.error("❌ فشل التأكد من الجداول (ensureSchema):", error);
  } finally {
    client.release();
  }
}

// دالة لاختبار الاتصال المبدئي بقاعدة البيانات + تأكيد الجداول
export async function initializeDatabase() {
  if (USE_LOCAL_STORE) {
    console.log(`ℹ️ ما فيه DATABASE_URL — يتم استخدام مخزّن محلي بملف: ${localStore.filePath}`);
    return;
  }
  try {
    const client = await pool!.connect();
    console.log("✅ تم الاتصال بقاعدة بيانات PostgreSQL بنجاح!");
    client.release();
    await ensureSchema();
    // تقليم أولي عند الإقلاع، تحسباً لأي بيانات قديمة متراكمة من قبل.
    await Promise.all([
      pruneTable("winners", MAX_WINNERS),
      pruneTable("tournament_archives", MAX_ARCHIVES),
      pruneTable("tournament_records", MAX_RECORDS),
    ]);
  } catch (error) {
    console.error("❌ فشل الاتصال بقاعدة البيانات:", error);
  }
}

// ==========================================
// 2. دوال إدارة البطولات (Tournament State)
// ==========================================

export async function getTournamentState() {
  if (USE_LOCAL_STORE) return localStore.getState();
  if (!db) throw new Error("Database not initialized");
  // جلب أحدث صف لحالة البطولة (نتأكد دايماً نجيب آخر تحديث، مو أي صف عشوائي)
  return await db.query.tournamentStateTable.findFirst({
    orderBy: [desc(schema.tournamentStateTable.id)],
  });
}

export async function saveTournamentState(tournamentData: any) {
  if (USE_LOCAL_STORE) return localStore.saveState(tournamentData);
  if (!db) throw new Error("Database not initialized");

  // مهم: نحدث الصف الموجود إذا فيه، وإلا ننشئ صف واحد بس.
  // لو استعملنا insert بدون تحقق، كل تغيير (كل ضغطة فوز) بينشئ صف جديد ويكدس الجدول بلا داعي.
  //
  // كاين مشكلة إضافية: لو جاو طلبين حفظ فنفس الوقت تقريباً (مثلاً كليكين سريعين)،
  // الاثنين يقدرو يقراو "لا كاين صف موجود" فنفس اللحظة، ويديرو INSERT بالتوازي،
  // فيتزادو صفين بدل صف واحد. نستعمل pg_advisory_xact_lock باش نقفل العملية:
  // أي حفظ ثاني لازم ينتظر الأول يكمل (transaction كاملة) قبل ما يبدا.
  //
  // كمان: نشيل أي حقل "id" و"createdAt" ممكن يكونو منزلقين داخل tournamentData
  // (مثلاً لو الكائن جاي أصلاً من صف قاعدة بيانات سابق)، عشان ما يتصادمش مع
  // صف آخر ويسبب خطأ فريد (unique constraint) أو تحديث غلط.
  //
  // ✅ إصلاح "فشل حفظ الحالة": كنا ما نشيلوش updatedAt من tournamentData رغم
  // إنه يجي رقم خام (Date.now()) من الفرونت/من tournament.ts، مو كائن Date.
  // عمود updated_at نوعه timestamp، وبوستغرس يرفض رقم خام فـ INSERT (يقبله
  // بالخطأ فـ UPDATE بس لأننا كنا نكتبو updatedAt: new Date() بعدها فـ
  // نفس الكائن فتتجاوز القيمة الغلط). النتيجة: أول عملية حفظ (لما الجدول
  // فاضي، مثلاً بعد إعادة نشر أو DB جديدة) كانت تفشل دايماً فـ INSERT،
  // وبما إن الصف الأول ما ينحفظش أبداً، كل محاولة حفظ بعدها كانت تدخل
  // لنفس مسار INSERT وتفشل من جديد → "فشل حفظ الحالة" بشكل دائم.
  const { id: _ignoredId, createdAt: _ignoredCreatedAt, updatedAt: _ignoredUpdatedAt, ...safeData } = tournamentData || {};

  return await db.transaction(async (tx: any) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(727271)`);

    const existing = await tx.query.tournamentStateTable.findFirst({
      orderBy: [desc(schema.tournamentStateTable.id)],
    });

    if (existing) {
      return await tx
        .update(schema.tournamentStateTable)
        .set({ ...safeData, updatedAt: new Date() })
        .where(eq(schema.tournamentStateTable.id, existing.id))
        .returning();
    }

    // ✅ نفس الإصلاح هنا: نحدد updatedAt كـ Date() حقيقي بدل ما نخلي
    // القيمة الخام (لو وجدت) تتسرب لـ INSERT وتفشل العملية.
    return await tx.insert(schema.tournamentStateTable)
      .values({ ...safeData, updatedAt: new Date() })
      .returning();
  });
}

// ==========================================
// 3. دوال إدارة الفائزين (Winners)
// ==========================================

export async function getWinners() {
  if (USE_LOCAL_STORE) return localStore.getWinners();
  if (!db) throw new Error("Database not initialized");
  // جلب الفائزين وترتيبهم من الأحدث للأقدم
  return await db.query.winnersTable.findMany({
    orderBy: [desc(schema.winnersTable.date)],
  });
}

export async function addWinner(winnerData: typeof schema.winnersTable.$inferInsert) {
  if (USE_LOCAL_STORE) return localStore.addWinner(winnerData);
  if (!db) throw new Error("Database not initialized");
  // إضافة فائز جديد للجدول
  const result = await db.insert(schema.winnersTable)
    .values(winnerData)
    .returning();
  // نقلّم الجدول بعد كل إضافة عشان ما يكبرش بلا حدود (يبقي فقط أحدث MAX_WINNERS صف)
  pruneTable("winners", MAX_WINNERS).catch(() => {});
  return result;
}

// ==========================================
// 4. دوال الأرشيف (Archives)
// ==========================================

export async function getArchives() {
  if (USE_LOCAL_STORE) return localStore.getArchives();
  if (!db) throw new Error("Database not initialized");
  // جلب أرشيف البطولات المنتهية وترتيبها حسب وقت الانتهاء
  return await db.query.tournamentArchivesTable.findMany({
    orderBy: [desc(schema.tournamentArchivesTable.finishedAt)],
  });
}

export async function getArchiveById(archiveId: number) {
  if (USE_LOCAL_STORE) return localStore.getArchiveById(archiveId);
  if (!db) throw new Error("Database not initialized");
  // جلب تفاصيل بطولة قديمة محددة بواسطة الـ ID
  return await db.query.tournamentArchivesTable.findFirst({
    where: eq(schema.tournamentArchivesTable.id, archiveId),
  });
}

export async function addArchive(archiveData: typeof schema.tournamentArchivesTable.$inferInsert) {
  if (USE_LOCAL_STORE) return localStore.addArchive(archiveData);
  if (!db) throw new Error("Database not initialized");
  // حفظ بيانات البطولة بعد انتهائها في الأرشيف
  const result = await db.insert(schema.tournamentArchivesTable)
    .values(archiveData)
    .returning();
  // تقليم الأرشيف (يبقي فقط أحدث MAX_ARCHIVES بطولة — كل صف فيه rounds/players كاملة فهو ثقيل)
  pruneTable("tournament_archives", MAX_ARCHIVES).catch(() => {});
  return result;
}

// ==========================================
// 5. دوال سجل البطولات (Tournament Records)
// ==========================================

export async function getTournamentRecords() {
  if (USE_LOCAL_STORE) return localStore.getRecords();
  if (!db) throw new Error("Database not initialized");
  // جلب سجلات البطولات مرتبة من الأحدث للأقدم
  return await db.query.tournamentRecordsTable.findMany({
    orderBy: [desc(schema.tournamentRecordsTable.createdAt)],
  });
}

export async function addTournamentRecord(recordData: typeof schema.tournamentRecordsTable.$inferInsert) {
  if (USE_LOCAL_STORE) return localStore.addRecord(recordData);
  if (!db) throw new Error("Database not initialized");
  // إضافة سجل بطولة جديد (اسم البطولة + الفائز + الصورة)
  const result = await db.insert(schema.tournamentRecordsTable)
    .values(recordData)
    .returning();
  // أهم مكان للتقليم: كل صورة Base64 ممكن توصل لمئات الـ KB، فـ هذا الجدول
  // هو الأكثر عرضة لاستهلاك التخزين بسرعة. نبقي فقط أحدث MAX_RECORDS صورة.
  pruneTable("tournament_records", MAX_RECORDS).catch(() => {});
  return result;
}

// تعديل (أو إنشاء) سجل لعبة بالمفتاح tournamentName (اسم اللعبة).
// النظام الجديد: الأدمن يعدّل صورة اللعبة بدل ما يضيف بطولة جديدة، فلكل لعبة
// سجل واحد فقط. لو فيه سجل بنفس اسم اللعبة نحدّث صورته، وإلا ننشئ سجل جديد.
export async function upsertTournamentRecord(recordData: typeof schema.tournamentRecordsTable.$inferInsert) {
  if (USE_LOCAL_STORE) return localStore.upsertRecord(recordData);
  if (!db) throw new Error("Database not initialized");
  const existing = await db.query.tournamentRecordsTable.findFirst({
    where: eq(schema.tournamentRecordsTable.tournamentName, recordData.tournamentName ?? ""),
  });
  if (existing) {
    // displayName يُحدَّث فقط إذا جاء فـ الطلب، وإلا نبقي القيمة المحفوظة سابقاً.
    const setData: Record<string, any> = {
      winnerName: recordData.winnerName ?? "",
      image: recordData.image ?? "",
    };
    if (recordData.displayName !== undefined) setData.displayName = recordData.displayName;
    // image2 يُحدَّث فقط إذا جاء فـ الطلب، وإلا نبقي القيمة المحفوظة سابقاً.
    if (recordData.image2 !== undefined) setData.image2 = recordData.image2;
    return await db.update(schema.tournamentRecordsTable)
      .set(setData)
      .where(eq(schema.tournamentRecordsTable.id, existing.id))
      .returning();
  }
  const result = await db.insert(schema.tournamentRecordsTable)
    .values(recordData)
    .returning();
  pruneTable("tournament_records", MAX_RECORDS).catch(() => {});
  return result;
}

export async function deleteTournamentRecord(recordId: number) {
  if (USE_LOCAL_STORE) return localStore.deleteRecord(recordId);
  if (!db) throw new Error("Database not initialized");
  // حذف سجل بطولة بواسطة الـ ID
  return await db.delete(schema.tournamentRecordsTable)
    .where(eq(schema.tournamentRecordsTable.id, recordId))
    .returning();
}

// إخفاء/إظهار كرت فائز من الصفحة العامة بدون حذف بياناته (اسم الفائز + الصورة يبقون محفوظين).
export async function setTournamentRecordVisibility(recordId: number, isHidden: boolean) {
  if (USE_LOCAL_STORE) return localStore.setRecordVisibility(recordId, isHidden);
  if (!db) throw new Error("Database not initialized");
  return await db.update(schema.tournamentRecordsTable)
    .set({ isHidden })
    .where(eq(schema.tournamentRecordsTable.id, recordId))
    .returning();
}

// ==========================================
// 6. دوال مساعدي الأدمن (Admin Helpers)
// ==========================================
// الأدمن الرئيسي (بكلمة مرور ADMIN_PASSWORD) هو الوحيد اللي يقدر ينشئ/يعدّل/يحذف
// هذي الحسابات. كل مساعد عنده كود دخول خاص + صلاحيات محددة يختارها الأدمن.

export async function getAdminHelpers() {
  if (USE_LOCAL_STORE) return localStore.getHelpers();
  if (!db) throw new Error("Database not initialized");
  return await db.query.adminHelpersTable.findMany({
    orderBy: [desc(schema.adminHelpersTable.createdAt)],
  });
}

export async function findAdminHelperByCode(code: string) {
  if (USE_LOCAL_STORE) return localStore.findHelperByCode(code);
  if (!db) throw new Error("Database not initialized");
  return await db.query.adminHelpersTable.findFirst({
    where: eq(schema.adminHelpersTable.code, code),
  });
}

export async function addAdminHelper(helperData: typeof schema.adminHelpersTable.$inferInsert) {
  if (USE_LOCAL_STORE) return localStore.addHelper(helperData);
  if (!db) throw new Error("Database not initialized");
  const result = await db.insert(schema.adminHelpersTable).values(helperData).returning();
  return result[0];
}

export async function updateAdminHelperPermissions(id: number, permissions: Record<string, boolean>) {
  if (USE_LOCAL_STORE) return localStore.updateHelperPermissions(id, permissions);
  if (!db) throw new Error("Database not initialized");
  const result = await db.update(schema.adminHelpersTable)
    .set({ permissions })
    .where(eq(schema.adminHelpersTable.id, id))
    .returning();
  return result[0] || null;
}

export async function deleteAdminHelper(id: number) {
  if (USE_LOCAL_STORE) return localStore.deleteHelper(id);
  if (!db) throw new Error("Database not initialized");
  const result = await db.delete(schema.adminHelpersTable)
    .where(eq(schema.adminHelpersTable.id, id))
    .returning();
  return result[0] || null;
}

// ==========================================
// 7. دوال فوزات اللاعبين (Player Wins) — أساس اللفل وشريط التقدّم
// ==========================================
// تطبيع اسم اللاعب: يوحّد الأحرف ويشيل الفراغات الزايدة ويصغّر الحروف عشان
// المطابقة تكون دقيقة (نفس المنطق المستعمل بالواجهة عند التحقق من كيك).
export function normalizePlayerName(name: string): string {
  return (name || "").normalize("NFKC").trim().toLowerCase();
}

// كل فوزات لاعب معيّن (مصفوفة صفوف: لعبة → عدد فوزات)
export async function getPlayerWins(username: string) {
  const key = normalizePlayerName(username);
  if (!key) return [];
  if (USE_LOCAL_STORE) return localStore.getPlayerWins(key);
  if (!db) throw new Error("Database not initialized");
  return await db.query.playerWinsTable.findMany({
    where: eq(schema.playerWinsTable.username, key),
  });
}

// 📊 قائمة نظام المستويات: كل اللاعبين ومجموع فوزاتهم عبر كل الألعاب.
// ⚠️ هذي الدالة كانت **ناقصة تماماً** من هذا الملف رغم إن مسار /player/levels
// يستدعيها — فكان النداء يرمي TypeError، والمسار يبلعه ويرجّع [] بصمت، وتطلع
// رسالة "ما فيه لاعب له فوزات بعد" حتى لو الجدول مليان لاعبين ومستويات.
// نجمع حسب username المطبَّع (كل صف = لاعب + لعبة وحدة) عشان الرقم بالقائمة
// يطابق "إجمالي الفوزات" الظاهر بتفاصيل نفس اللاعب.
export async function getPlayerLevels(limit = 500) {
  const n = Math.max(1, Math.min(2000, Math.floor(Number(limit) || 500)));
  if (USE_LOCAL_STORE) return localStore.getPlayerLevels(n);
  if (!db || !pool) throw new Error("Database not initialized");
  const result = await pool.query(
    `SELECT username,
            MAX(NULLIF(BTRIM(display_name), '')) AS display_name,
            SUM(wins)::int AS total
       FROM player_wins
      GROUP BY username
     HAVING SUM(wins) > 0
      ORDER BY total DESC, username ASC
      LIMIT $1`,
    [n],
  );
  return (result.rows || []).map((r: any) => ({
    username: (r.display_name && String(r.display_name).trim()) || r.username,
    wins: Number(r.total) || 0,
  }));
}

// 🧹 تصفير نظام المستويات كامل: يمسح فوزات كل اللاعبين في كل الألعاب.
// مستقل تماماً عن resetAllPlayerMatchWins (ذاك يخص نقاط "الأكثر انتصاراً").
// نحسب عدد اللاعبين المتأثرين قبل المسح عشان الرسالة تطلع بعدد لاعبين مو صفوف.
export async function resetAllPlayerWins() {
  if (USE_LOCAL_STORE) return localStore.resetAllPlayerWins();
  if (!db || !pool) throw new Error("Database not initialized");
  const before = await pool.query(
    `SELECT COUNT(DISTINCT username)::int AS n FROM player_wins WHERE wins > 0`,
  );
  await pool.query(`DELETE FROM player_wins`);
  return { cleared: Number(before.rows?.[0]?.n) || 0 };
}

// تحديد قيمة فوزات محددة لـ (لاعب + لعبة) — يُستخدم لتصحيح الأدمن اليدوي.
export async function setPlayerWins(username: string, displayName: string, game: string, wins: number) {
  const key = normalizePlayerName(username);
  const g = (game || "").trim();
  const safeWins = Math.max(0, Math.floor(Number(wins) || 0));
  if (!key || !g) return null;
  if (USE_LOCAL_STORE) return localStore.setPlayerWins(key, displayName || username, g, safeWins);
  if (!db) throw new Error("Database not initialized");
  const existing = await db.query.playerWinsTable.findFirst({
    where: sql`${schema.playerWinsTable.username} = ${key} AND ${schema.playerWinsTable.game} = ${g}`,
  });
  if (existing) {
    const result = await db.update(schema.playerWinsTable)
      .set({ wins: safeWins, displayName: displayName || existing.displayName, updatedAt: new Date() })
      .where(eq(schema.playerWinsTable.id, existing.id))
      .returning();
    return result[0] || null;
  }
  const result = await db.insert(schema.playerWinsTable)
    .values({ username: key, displayName: displayName || username, game: g, wins: safeWins })
    .returning();
  return result[0] || null;
}

// 🏆 قائمة المتصدّرين: يجمع فوزات كل لاعب ويرجّع أعلى `limit` لاعبين.
// مهم: نحسب فقط الفوزات اللي مفتاحها (game) يخص لعبة لها كرت فعلي
// (tournament_records) — نفس المفاتيح اللي يعرضها اللفل تحت كل كرت. كذا مجموع
// التوب يطابق مجموع أرقام اللفل الظاهرة، وما نعدّش "صفوف أشباح" اتسجّلت تحت
// أسماء بطولات حية (st.name) لا تقابل أي كرت، اللي كانت تنفخ الرقم بلا مقابل مرئي.
export async function getLeaderboard(limit = 3) {
  const n = Math.max(1, Math.floor(Number(limit) || 3));
  if (USE_LOCAL_STORE) return localStore.getLeaderboard(n);
  if (!db || !pool) throw new Error("Database not initialized");
  // 🩹 شبكة أمان: لو الجدول ناقص (نشرة قديمة اشتغلت قبل إصلاح ensureSchema)
  // ننشئه هنا فوراً بدل ما نرمي خطأ ونخلي القائمة فاضية للأبد.
  await ensurePlayerMatchWinsTable();
  // 🔧 المصدر = جدول player_match_wins (ماتشات مكسوبة) — نفس اللي يستخدمه
  // المخزّن المحلي، وهو المقصود بـ"توب الفائزين" حسب تعليق مسار /player/match-win.
  // (كان يقرأ من player_wins وهو خاص بلفل الكروت، فتطلع أرقام مختلفة عن المحلي
  // ويصير التحكم اليدوي من لوحة الأدمن بلا أثر.)
  const result = await pool.query(
    `SELECT username, display_name, wins::int AS total
       FROM player_match_wins
      WHERE wins > 0
      ORDER BY total DESC, updated_at ASC
      LIMIT $1`,
    [n],
  );
  return (result.rows || []).map((r: any) => ({
    username: (r.display_name && String(r.display_name).trim()) || r.username,
    wins: Number(r.total) || 0,
  }));
}

// زيادة (أو إنقاص) فوزات لاعب في لعبة بمقدار delta — الاحتساب التلقائي يستدعيها بـ +1.
export async function incrementPlayerWin(username: string, displayName: string, game: string, delta = 1) {
  const key = normalizePlayerName(username);
  const g = (game || "").trim();
  if (!key || !g) return null;
  if (USE_LOCAL_STORE) return localStore.incrementPlayerWin(key, displayName || username, g, delta);
  if (!db) throw new Error("Database not initialized");
  const existing = await db.query.playerWinsTable.findFirst({
    where: sql`${schema.playerWinsTable.username} = ${key} AND ${schema.playerWinsTable.game} = ${g}`,
  });
  if (existing) {
    const next = Math.max(0, (existing.wins || 0) + delta);
    const result = await db.update(schema.playerWinsTable)
      .set({ wins: next, displayName: displayName || existing.displayName, updatedAt: new Date() })
      .where(eq(schema.playerWinsTable.id, existing.id))
      .returning();
    return result[0] || null;
  }
  const result = await db.insert(schema.playerWinsTable)
    .values({ username: key, displayName: displayName || username, game: g, wins: Math.max(0, delta) })
    .returning();
  return result[0] || null;
}

// ── 🏆 نقاط التوب (ماتشات مكسوبة) ──
//
// 🩹 ضمانة إضافية لوجود جدول player_match_wins.
// السبب: الجدول كان ناقصاً من ensureSchema، فأي خادم منشور قبل هذا الإصلاح
// عنده قاعدة بيانات بدون الجدول. أضفناه لـ ensureSchema (يشتغل عند الإقلاع)،
// وهذي الدالة تغطّي الحالة اللي ما فيها إعادة تشغيل: أول نداء يلمس النقاط
// ينشئ الجدول لو ناقص. تنفّذ مرة وحدة بالعملية (نخزّن الوعد) عشان ما نضرب
// قاعدة البيانات باستعلام زيادة مع كل طلب.
let matchWinsTableReady: Promise<void> | null = null;
async function ensurePlayerMatchWinsTable() {
  if (USE_LOCAL_STORE || !pool) return;
  if (!matchWinsTableReady) {
    matchWinsTableReady = (async () => {
      await pool!.query(`
        CREATE TABLE IF NOT EXISTS player_match_wins (
          id serial PRIMARY KEY,
          username text NOT NULL,
          display_name text NOT NULL DEFAULT '',
          wins integer NOT NULL DEFAULT 0,
          updated_at timestamp NOT NULL DEFAULT now(),
          created_at timestamp NOT NULL DEFAULT now()
        );
      `);
      await pool!.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_player_match_wins_user ON player_match_wins (username);`,
      ).catch(() => { /* مكرّرات قديمة — ensureSchema يتكفّل بدمجها عند الإقلاع */ });
    })().catch((error) => {
      // لو فشل، نصفّر الكاش عشان المحاولة الجاية تعيد المحاولة بدل ما تعلق
      matchWinsTableReady = null;
      throw error;
    });
  }
  return matchWinsTableReady;
}

// ⚠️ كانت incrementPlayerMatchWin ناقصة من هذا الملف رغم إن مسار
// /player/match-win يستدعيها — فكان العدّاد ما يزيد أبداً (الخطأ يُبلع بصمت
// بالواجهة). هذي إضافتها + تحكم يدوي كامل من لوحة الأدمن.
export async function incrementPlayerMatchWin(username: string, displayName: string, delta = 1) {
  const key = normalizePlayerName(username);
  if (!key) return null;
  if (USE_LOCAL_STORE) return localStore.incrementPlayerMatchWin(key, displayName || username, delta);
  if (!db) throw new Error("Database not initialized");
  await ensurePlayerMatchWinsTable();
  const existing = await db.query.playerMatchWinsTable.findFirst({
    where: eq(schema.playerMatchWinsTable.username, key),
  });
  if (existing) {
    const next = Math.max(0, (existing.wins || 0) + delta);
    const result = await db.update(schema.playerMatchWinsTable)
      .set({ wins: next, displayName: displayName || existing.displayName, updatedAt: new Date() })
      .where(eq(schema.playerMatchWinsTable.id, existing.id))
      .returning();
    return result[0] || null;
  }
  const result = await db.insert(schema.playerMatchWinsTable)
    .values({ username: key, displayName: displayName || username, wins: Math.max(0, delta) })
    .returning();
  return result[0] || null;
}

// ✍️ تعيين قيمة صريحة لنقاط لاعب (تحكم يدوي من الأدمن).
export async function setPlayerMatchWins(username: string, displayName: string, wins: number) {
  const key = normalizePlayerName(username);
  if (!key) return null;
  const value = Math.max(0, Math.floor(Number(wins) || 0));
  if (USE_LOCAL_STORE) return localStore.setPlayerMatchWins(key, displayName || username, value);
  if (!db) throw new Error("Database not initialized");
  await ensurePlayerMatchWinsTable();
  const existing = await db.query.playerMatchWinsTable.findFirst({
    where: eq(schema.playerMatchWinsTable.username, key),
  });
  if (existing) {
    const result = await db.update(schema.playerMatchWinsTable)
      .set({ wins: value, displayName: displayName || existing.displayName, updatedAt: new Date() })
      .where(eq(schema.playerMatchWinsTable.id, existing.id))
      .returning();
    return result[0] || null;
  }
  const result = await db.insert(schema.playerMatchWinsTable)
    .values({ username: key, displayName: displayName || username, wins: value })
    .returning();
  return result[0] || null;
}

// 🧹 تصفير نقاط التوب لكل اللاعبين.
export async function resetAllPlayerMatchWins() {
  if (USE_LOCAL_STORE) return localStore.resetAllPlayerMatchWins();
  if (!db || !pool) throw new Error("Database not initialized");
  await ensurePlayerMatchWinsTable();
  const result = await pool.query(`DELETE FROM player_match_wins`);
  return { cleared: result.rowCount || 0 };
}

// ── 📜 سجل كروت البطولات (لقطة عند كل حفظ) ──

export interface RecordHistoryRow {
  id: number;
  tournamentName: string;
  displayName: string;
  winnerName: string;
  image: string;
  savedAt: string;
}

/**
 * يضيف لقطة جديدة للسجل. نتجاهل الإضافة لو آخر لقطة لنفس اللعبة تطابقها
 * (نفس الصورة ونفس الفائز) — عشان ما يتكرر السطر مع كل حفظ ما فيه تغيير.
 */
export async function addRecordHistory(entry: {
  tournamentName: string;
  displayName?: string;
  winnerName?: string;
  image?: string;
}): Promise<RecordHistoryRow | null> {
  const name = (entry.tournamentName || "").trim();
  const image = entry.image || "";
  const winner = entry.winnerName || "";
  if (!name || (!image && !winner)) return null;

  if (USE_LOCAL_STORE) return localStore.addRecordHistory({ ...entry, tournamentName: name });
  if (!pool) throw new Error("Database not initialized");

  const prev = await pool.query(
    `SELECT image, winner_name FROM record_history
      WHERE tournament_name = $1 ORDER BY saved_at DESC LIMIT 1`,
    [name],
  );
  const last = prev.rows?.[0];
  if (last && last.image === image && last.winner_name === winner) return null;

  const res = await pool.query(
    `INSERT INTO record_history (tournament_name, display_name, winner_name, image)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [name, entry.displayName || "", winner, image],
  );
  const r = res.rows[0];
  return {
    id: r.id,
    tournamentName: r.tournament_name,
    displayName: r.display_name,
    winnerName: r.winner_name,
    image: r.image,
    savedAt: new Date(r.saved_at).toISOString(),
  };
}

/** يجيب السجل مرتّباً من الأحدث. */
export async function getRecordHistory(limit = 300): Promise<RecordHistoryRow[]> {
  const n = Math.max(1, Math.min(1000, Math.floor(limit) || 300));
  if (USE_LOCAL_STORE) return localStore.getRecordHistory(n);
  if (!pool) throw new Error("Database not initialized");
  const res = await pool.query(
    `SELECT * FROM record_history ORDER BY saved_at DESC LIMIT $1`, [n],
  );
  return (res.rows || []).map((r: any) => ({
    id: r.id,
    tournamentName: r.tournament_name,
    displayName: r.display_name,
    winnerName: r.winner_name,
    image: r.image,
    savedAt: new Date(r.saved_at).toISOString(),
  }));
}

/** حذف لقطة من السجل (لا يمس الكرت نفسه). */
export async function deleteRecordHistory(id: number): Promise<boolean> {
  if (USE_LOCAL_STORE) return localStore.deleteRecordHistory(id);
  if (!pool) throw new Error("Database not initialized");
  const res = await pool.query(`DELETE FROM record_history WHERE id = $1`, [id]);
  return (res.rowCount || 0) > 0;
}
