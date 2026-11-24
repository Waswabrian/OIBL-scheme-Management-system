const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const bcrypt = require("bcrypt");
const ExcelJS = require("exceljs");
const db = require("./config/db");
const pool = require('./config/db');
const { validateAllocationRequest } = require('./utils/allocationValidation');
const { validateSchemeInput, normalizeSchemeStatus } = require('./utils/schemeValidation');
const { sendAppEmail } = require('./utils/emailNotifications');
const { generateTemporaryPassword, getResetPasswordRequired, passwordMeetsPolicy } = require('./utils/passwordManagement');

const app = express();
const PORT =  process.env.PORT || 3001;

// ---------- In-memory fallback (used only if the DB is unreachable) ----------
const memoryUsers = [];
const memoryActivities = [];
let dbReady = false;
const DEFAULT_ADMIN_EMAIL = (process.env.DEFAULT_ADMIN_EMAIL || 'admin@oibl.com').trim().toLowerCase();
const DEFAULT_ADMIN_PASSWORD = process.env.DEFAULT_ADMIN_PASSWORD || 'Admin@123';

// ---------- Helpers ----------
const normalizeRole = (role) => {
  const safeRole = typeof role === "string" ? role.trim() : "";
  const validRoles = ["Staff", "Admin", "Super Admin", "Business Development Officer"];
  if (validRoles.includes(safeRole)) return safeRole;
  return "Staff"; // Default fallback
};
const ROLES = {
  SUPER_ADMIN: "Super Admin",
  ADMIN: "Admin",
  BDO: "Business Development Officer",
  STAFF: "Staff"
};

const methodOverride = require('method-override');

app.use(methodOverride('_method'));

const getDashboardRoute = (role) => {
  const safeRole = normalizeRole(role);
  if (safeRole === "Business Development Officer") return "/bdo-dashboard";
  if (safeRole === "Staff") return "/staff-dashboard";
  if(safeRole === "Admin") return "/admin-dashboard";
  if (safeRole === "Super Admin") return "/super-admin-dashboard";
  return "/admin-dashboard"; // Admin
};

const requireAuth = (req, res, next) => {
  if (!req.session.user)
     return res.redirect("/login");
  next();
};

const redirectIfLoggedIn = (req, res, next) => {
  if (req.session.user) return res.redirect(getDashboardRoute(req.session.user.role));
  next();
};

// ---------- DB bootstrap ----------
const ensureStaffSchema = async () => {
  try {
    await db.query(
      `CREATE TABLE IF NOT EXISTS staff (
        staff_id INT AUTO_INCREMENT PRIMARY KEY,
        full_name VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE,
        password VARCHAR(255) NOT NULL,
        role ENUM('Super Admin','Admin','Business Development Officer','Staff') DEFAULT 'Staff',
        status ENUM('Active','Inactive') DEFAULT 'Active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`
    );

    await db.query(
      "ALTER TABLE staff ADD COLUMN IF NOT EXISTS password VARCHAR(255) NOT NULL DEFAULT ''"
    );
    await db.query(
      "ALTER TABLE staff ADD COLUMN IF NOT EXISTS password_reset_required BOOLEAN NOT NULL DEFAULT FALSE"
    );
    await db.query(
      "ALTER TABLE staff ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMP NULL"
    );
    await db.query(
      "ALTER TABLE staff MODIFY COLUMN role ENUM('Super Admin','Admin','Business Development Officer','Staff') DEFAULT 'Staff'"
    );
    await db.query(
      "ALTER TABLE staff ADD COLUMN IF NOT EXISTS status ENUM('Active','Inactive') DEFAULT 'Active'"
    );
    await db.query(
      "ALTER TABLE staff ADD COLUMN IF NOT EXISTS bio TEXT NULL"
    );
  } catch (err) {
    console.error("[db] schema check failed:", err.message);
  }
};

const ensureSchemeSchema = async () => {
  try {
    await db.query(
      `CREATE TABLE IF NOT EXISTS schemes (
        scheme_id INT AUTO_INCREMENT PRIMARY KEY,
        scheme_name VARCHAR(150) NOT NULL,
        status ENUM('Onboarding','Pending_Renewal','Renewed','Active','Lost') DEFAULT 'Onboarding',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`
    );

    await db.query("ALTER TABLE schemes ADD COLUMN IF NOT EXISTS created_by INT NULL");
    await db.query("ALTER TABLE schemes ADD COLUMN IF NOT EXISTS insurer VARCHAR(150) NULL");
    await db.query("ALTER TABLE schemes ADD COLUMN IF NOT EXISTS policy_type VARCHAR(100) NULL");
    await db.query("ALTER TABLE schemes ADD COLUMN IF NOT EXISTS premium DECIMAL(12,2) NULL");
    await db.query("ALTER TABLE schemes ADD COLUMN IF NOT EXISTS inception_date DATE NULL");
    await db.query("ALTER TABLE schemes ADD COLUMN IF NOT EXISTS assigned_to VARCHAR(150) NULL");
    await db.query("ALTER TABLE schemes ADD COLUMN IF NOT EXISTS start_date DATE NULL");
    await db.query("ALTER TABLE schemes ADD COLUMN IF NOT EXISTS end_date DATE NULL");
    await db.query("ALTER TABLE schemes ADD COLUMN IF NOT EXISTS budget DECIMAL(12,2) NULL");
    await db.query(
      "ALTER TABLE schemes MODIFY COLUMN status ENUM('Onboarding','Pending_Renewal','Renewed','Active','Lost') DEFAULT 'Onboarding'"
    );

  } catch (err) {
    console.error("[db] scheme schema check failed:", err.message);
  }
};

const ensureActivitySchema = async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS app_activity_log (
        activity_id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NULL,
        user_name VARCHAR(150) NULL,
        title VARCHAR(200) NULL,
        detail TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    for (const columnDefinition of [
      "ALTER TABLE app_activity_log ADD COLUMN IF NOT EXISTS user_name VARCHAR(150) NULL",
      "ALTER TABLE app_activity_log ADD COLUMN IF NOT EXISTS title VARCHAR(200) NULL",
      "ALTER TABLE app_activity_log ADD COLUMN IF NOT EXISTS detail TEXT NULL",
      "ALTER TABLE app_activity_log ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP"
    ]) {
      try {
        await db.query(columnDefinition);
      } catch (altErr) {
        if (!altErr.message.includes('already exists') && !altErr.message.includes('Duplicate')) {
          console.warn('[db] activity column check:', altErr.message);
        }
      }
    }
  } catch (err) {
    console.error("[db] activity schema check failed:", err.message);
  }
};

const ensureSystemSettingsSchema = async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS system_settings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        company_name VARCHAR(150) NULL,
        system_email VARCHAR(150) NULL,
        password_length INT DEFAULT 8,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const [rows] = await db.query('SELECT * FROM system_settings ORDER BY created_at DESC LIMIT 1');
    if (!rows.length) {
      await db.query(
        'INSERT INTO system_settings (company_name, system_email, password_length) VALUES (?, ?, ?)',
        ['OIBL Schemes', 'admin@oibl.com', 8]
      );
    }
  } catch (err) {
    console.error('[db] system settings schema check failed:', err.message);
  }
};

const ensureAllocationSchema = async () => {
  try {
    await db.query(
      `CREATE TABLE IF NOT EXISTS scheme_allocations (
        allocation_id INT AUTO_INCREMENT PRIMARY KEY,
        scheme_id INT NOT NULL,
        staff_id INT NOT NULL,
        allocated_by INT NULL,
        status ENUM('Active','Inactive','Pending') DEFAULT 'Active',
        allocated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`
    );
    
    try {
      await db.query('ALTER TABLE scheme_allocations ADD UNIQUE KEY unique_scheme_id (scheme_id)');
      console.log('[db] Added unique constraint on scheme_allocations.scheme_id');
    } catch (constraintErr) {
      if (!constraintErr.message.includes('already exists') && !constraintErr.message.includes('Duplicate')) {
        console.error('[db] unique constraint addition failed:', constraintErr.message);
      }
    }
  } catch (err) {
    if (!err.message.includes('already exists')) {
      console.error('[db] allocation schema check failed:', err.message);
    }
  }
};

const ensureDefaultAdminUser = async () => {
  if (!dbReady) return;

  try {
    const [[row]] = await db.query('SELECT COUNT(*) AS total FROM staff');
    if (Number(row.total) > 0) return;

    const hashedPassword = await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, 10);
    await db.query(
      "INSERT INTO staff (full_name, email, password, role, status) VALUES (?, ?, ?, 'Admin', 'Active')",
      ['System Admin', DEFAULT_ADMIN_EMAIL, hashedPassword]
    );

    console.log(`[auth] Created default admin account: ${DEFAULT_ADMIN_EMAIL} / ${DEFAULT_ADMIN_PASSWORD}`);
  } catch (err) {
    console.error("[auth] default admin setup failed:", err.message);
  }
};

const initDb = async () => {
  try {
    await ensureStaffSchema();
    await ensureSchemeSchema();
    await ensureActivitySchema();
    await ensureSystemSettingsSchema();
    await ensureAllocationSchema();
    dbReady = true;
    await ensureDefaultAdminUser();
    console.log("[db] Connected. Staff, scheme, and system tables ready.");
  } catch (err) {
    dbReady = false;
    console.error("[db] Unavailable, falling back to in-memory storage:", err.message);
  }
};

// ---------- Data access (pool-based, auto-reconnects, always awaited) ----------
const getUserByEmail = async (email) => {
  if (dbReady) {
    try {
      const [rows] = await db.query("SELECT * FROM staff WHERE email = ?", [email]);
      return rows[0] || null;
    } catch (err) {
      console.error("[db] getUserByEmail failed:", err.message);
      dbReady = false; // trip fallback rather than hang the request
      return memoryUsers.find((u) => u.email === email) || null;
    }
  }
  return memoryUsers.find((u) => u.email === email) || null;
};

const saveUser = async (user) => {
  const safeUser = { ...user, role: normalizeRole(user.role) };

  if (dbReady) {
    try {
      const [result] = await db.query(
        "INSERT INTO staff (full_name, email, password, role) VALUES (?, ?, ?, ?)",
        [safeUser.full_name, safeUser.email, safeUser.password, safeUser.role]
      );
      return { id: result.insertId, ...safeUser };
    } catch (err) {
      console.error("[db] saveUser failed:", err.message);
      throw err;
    }
  }

  const newUser = { id: memoryUsers.length + 1, ...safeUser };
  memoryUsers.push(newUser);
  return newUser;
};

const updateUserPassword = async ({ staffId, password, forceReset = false }) => {
  if (!staffId || !password) return false;

  const hashedPassword = await bcrypt.hash(password, 10);

  if (dbReady) {
    const [result] = await db.query(
      'UPDATE staff SET password = ?, password_reset_required = ?, password_changed_at = NOW() WHERE staff_id = ?',
      [hashedPassword, forceReset ? 1 : 0, staffId]
    );

    return Number(result?.affectedRows || 0) > 0;
  }

  const memoryUser = memoryUsers.find((u) => String(u.id) === String(staffId));
  if (!memoryUser) return false;

  memoryUser.password = hashedPassword;
  memoryUser.password_reset_required = forceReset ? 1 : 0;
  memoryUser.password_changed_at = new Date();
  return true;
};

const getAssignedSchemeCount = async (userId) => {
  if (!userId) return 0;

  try {
    const [[row]] = await db.query(
      "SELECT COUNT(*) AS assignedSchemes FROM schemes WHERE created_by = ?",
      [userId]
    );
    return Number(row.assignedSchemes || 0);
  } catch (err) {
    try {
      const [[row]] = await db.query(
        "SELECT COUNT(*) AS assignedSchemes FROM schemes WHERE assigned_to = ?",
        [userId]
      );
      return Number(row.assignedSchemes || 0);
    } catch (fallbackErr) {
      console.error("[db] assigned scheme count failed:", fallbackErr.message);
      return 0;
    }
  }
};

const getDashboardStats = async (user) => {
  if (!dbReady) {
    return {
      totalSchemes: 0,
      pendingSchemes: 0,
      approvedSchemes: 0,
      staffCount: memoryUsers.length || 0,
      assignedSchemes: 0,
      prospects: 0
    };
  }

  try {
    const [[totalSchemesRow]] = await db.query("SELECT COUNT(*) AS totalSchemes FROM schemes");
    const [[pendingSchemesRow]] = await db.query("SELECT COUNT(*) AS pendingSchemes FROM schemes WHERE status = 'Pending'");
    const [[approvedSchemesRow]] = await db.query("SELECT COUNT(*) AS approvedSchemes FROM schemes WHERE status = 'Approved'");
    const [[staffCountRow]] = await db.query("SELECT COUNT(*) AS staffCount FROM staff");

    const assignedSchemes = user && user.id ? await getAssignedSchemeCount(user.id) : 0;

    return {
      totalSchemes: totalSchemesRow.totalSchemes || 0,
      pendingSchemes: pendingSchemesRow.pendingSchemes || 0,
      approvedSchemes: approvedSchemesRow.approvedSchemes || 0,
      staffCount: staffCountRow.staffCount || 0,
      assignedSchemes,
      prospects: 0
    };
  } catch (err) {
    console.error("[db] dashboard stats failed:", err.message);
    return {
      totalSchemes: 0,
      pendingSchemes: 0,
      approvedSchemes: 0,
      staffCount: 0,
      assignedSchemes: 0,
      prospects: 0
    };
  }
};

const getAllSchemes = async () => {
  if (!dbReady) return [];

  try {
    const [rows] = await db.query("SELECT * FROM schemes ORDER BY created_at DESC");
    return rows;
  } catch (err) {
    console.error("[db] getAllSchemes failed:", err.message);
    return [];
  }
};

const getAllStaff = async () => {
  if (!dbReady) return [];

  try {
    const [rows] = await db.query(
      "SELECT staff_id, full_name, email, role, status FROM staff ORDER BY full_name ASC"
    );
    return rows;
  } catch (err) {
    console.error("[db] getAllStaff failed:", err.message);
    return [];
  }
};

const resolveAssignedStaffId = async (assignedTo) => {
  const value = typeof assignedTo === "string" ? assignedTo.trim() : assignedTo;
  if (!value) return null;

  const [rows] = await db.query(
    "SELECT staff_id FROM staff WHERE staff_id = ? OR full_name = ? OR email = ? LIMIT 1",
    [value, value, value]
  );
  return rows[0]?.staff_id || null;
};

const resolveAssignedStaff = async (assignedTo) => {
  const value = typeof assignedTo === "string" ? assignedTo.trim() : assignedTo;
  if (!value) return null;

  const [rows] = await db.query(
    "SELECT staff_id, full_name, email FROM staff WHERE staff_id = ? OR full_name = ? OR email = ? LIMIT 1",
    [value, value, value]
  );
  return rows[0] || null;
};

const recordActivity = async ({ userId, userName, title, detail }) => {
  const entry = {
    activity_id: Date.now(),
    user_id: userId || null,
    user_name: userName || 'System',
    title: title || 'System event',
    detail: detail || 'System activity was recorded.',
    created_at: new Date().toISOString().slice(0, 19).replace('T', ' ')
  };

  if (dbReady) {
    try {
      await db.query(
        "INSERT INTO app_activity_log (user_id, user_name, title, detail) VALUES (?, ?, ?, ?)",
        [entry.user_id, entry.user_name, entry.title, entry.detail]
      );
      return entry;
    } catch (err) {
      console.error("[db] activity log failed:", err.message);
    }
  }

  memoryActivities.unshift(entry);
  return entry;
};

const notifyUserByEmail = async ({ to, subject, text, html }) => {
  if (!to) {
    return { sent: false, reason: 'Missing recipient' };
  }

  const targetEmails = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!targetEmails.length) {
    return { sent: false, reason: 'Missing recipient' };
  }

  const result = await sendAppEmail({
    to: targetEmails,
    subject,
    text,
    html
  });

  if (result.sent) {
    console.log(`[mail] Sent: ${subject} -> ${targetEmails.join(', ')}`);
  } else {
    console.warn(`[mail] Failed to send: ${subject} -> ${targetEmails.join(', ')} (${result.reason})`);
  }

  return result;
};

const getRecentActivities = async ({ userId, audience } = {}) => {
  if (dbReady) {
    try {
      let query = "SELECT activity.* FROM app_activity_log AS activity";
      const params = [];

      if (audience === "admin") {
        query += " INNER JOIN staff AS actor ON actor.staff_id = activity.user_id WHERE actor.role IN ('Admin', 'Super Admin')";
      } else if (audience === "staff" && userId) {
        query += " WHERE activity.user_id = ?";
        params.push(userId);
      }

      query += " ORDER BY activity.created_at DESC LIMIT 10";
      const [rows] = await db.query(
        query,
        params
      );
      return rows;
    } catch (err) {
      console.error("[db] recent activity query failed:", err.message);
    }
  }

  return memoryActivities
    .filter((activity) => {
      if (audience === "staff") return String(activity.user_id) === String(userId);
      return audience !== "admin" || ["Admin", "Super Admin"].includes(activity.user_role);
    })
    .slice(0, 10);
};

// ---------- Middleware ----------
app.set("view engine", "ejs");
app.use(express.json({ limit: "1mb" }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));
app.use("/images", express.static("views/images"));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "change-me-in-.env",
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, httpOnly: true }
  })
);

// ---------- Routes ----------
app.get("/", (req, res) => {
  res.render("index", { user: req.session.user });
});

app.get("/login", redirectIfLoggedIn, (req, res) => {
  res.render("auth/login", {
    error: req.query.error || "",
    success: req.query.success || ""
  });
});

app.get("/forgot-password", (req, res) => {
  res.render("auth/forgot-password", {
    error: req.query.error || "",
    success: req.query.success || ""
  });
});

app.post("/forgot-password", async (req, res) => {
  const normalizedEmail = String(req.body?.email || '').trim().toLowerCase();

  if (!normalizedEmail) {
    return res.redirect("/forgot-password?error=Please+enter+your+email");
  }

  try {
    const user = await getUserByEmail(normalizedEmail);

    if (user) {
      const minimumLength = await getSystemPasswordLength();
      const temporaryPassword = generateTemporaryPassword(Math.max(12, minimumLength));

      const passwordUpdated = await updateUserPassword({
        staffId: user.staff_id,
        password: temporaryPassword,
        forceReset: true
      });

      if (!passwordUpdated) {
        throw new Error('Unable to persist the temporary password');
      }

      await recordActivity({
        userId: user.staff_id,
        userName: user.full_name,
        title: 'Password reset requested',
        detail: `A password reset was issued for ${user.email}.`
      });

      const mailResult = await notifyUserByEmail({
        to: user.email,
        subject: 'Temporary password for OIBL Schemes',
        text: `Hello ${user.full_name},\n\nA password reset was requested for your account.\n\nTemporary password: ${temporaryPassword}\n\nSign in with this temporary password. You will be required to create a new password before continuing.\n\nIf you did not request this reset, contact the system administrator immediately.`,
        html: `<p>Hello ${user.full_name},</p><p>A password reset was requested for your account.</p><p><strong>Temporary password:</strong> ${temporaryPassword}</p><p>Sign in with this temporary password. You will be required to create a new password before continuing.</p><p>If you did not request this reset, contact the system administrator immediately.</p>`
      });

      if (!mailResult.sent) {
        console.warn('[forgot-password] Email delivery failed:', mailResult.reason);
        return res.redirect("/forgot-password?error=Password+was+reset+but+email+delivery+is+not+configured");
      }
    }

    return res.redirect("/login?success=If+that+account+exists,+a+temporary+password+has+been+sent");
  } catch (err) {
    console.error('[forgot-password]', err);
    return res.redirect("/forgot-password?error=Unable+to+reset+password");
  }
});

app.get("/change-password", requireAuth, (req, res) => {
  res.render("auth/change-password", {
    error: req.query.error || "",
    success: req.query.success || "",
    forced: req.query.forced === '1' || req.query.forced === 'true',
    user: req.session.user
  });
});

app.post("/change-password", requireAuth, async (req, res) => {
  const { current_password, new_password, confirm_password } = req.body || {};

  try {
    const user = await getUserByEmail(req.session.user.email);
    if (!user) {
      return res.redirect("/login?error=Session+expired");
    }

    const forcedReset = getResetPasswordRequired(user.password_reset_required);
    const [settingsRows] = await db.query('SELECT password_length FROM system_settings ORDER BY created_at DESC LIMIT 1');
    const minimumLength = Number(settingsRows?.[0]?.password_length || 8);

    if (!forcedReset) {
      const matchesCurrent = await bcrypt.compare(current_password || '', user.password).catch(() => false);
      if (!matchesCurrent) {
        return res.redirect("/change-password?error=Current+password+is+incorrect");
      }
    }

    if (!new_password || !confirm_password) {
      return res.redirect("/change-password?error=Please+enter+a+new+password");
    }

    if (new_password.length < minimumLength) {
      return res.redirect(`/change-password?error=Password+must+be+at+least+${minimumLength}+characters`);
    }

    if (!passwordMeetsPolicy(new_password, minimumLength)) {
      return res.redirect("/change-password?error=Password+must+include+letters+and+numbers");
    }

    if (new_password !== confirm_password) {
      return res.redirect("/change-password?error=New+passwords+do+not+match");
    }

    const passwordUpdated = await updateUserPassword({
      staffId: user.staff_id,
      password: new_password,
      forceReset: false
    });

    if (!passwordUpdated) {
      return res.redirect("/change-password?error=Unable+to+update+password");
    }

    await recordActivity({
      userId: user.staff_id,
      userName: user.full_name,
      title: 'Password changed',
      detail: `${user.full_name} updated their password.`
    });

    req.session.user = {
      ...req.session.user,
      full_name: user.full_name,
      email: user.email,
      role: user.role
    };

    return res.redirect(getDashboardRoute(user.role));
  } catch (err) {
    console.error('[change-password]', err);
    return res.redirect("/change-password?error=Unable+to+change+password");
  }
});

app.post("/login", redirectIfLoggedIn, async (req, res) => {

  const { email, password } = req.body;

  try {

    const normalizedEmail = String(email || '').trim().toLowerCase();
    const user = await getUserByEmail(normalizedEmail);

    if (!user) {
      return res.redirect("/login?error=Invalid+email+or+password");
    }

    const passwordMatch = await bcrypt.compare(String(password || ''), user.password).catch(() => false);
    if (!passwordMatch) {
      return res.redirect("/login?error=Invalid+email+or+password");
    }

    req.session.user = {
      id: user.staff_id,
      full_name: user.full_name,
      email: user.email,
      role: user.role
    };

    await notifyUserByEmail({
      to: user.email,
      subject: 'Successful login alert',
      text: `Hi ${user.full_name},\n\nWe detected a successful login to the OIBL Schemes system at ${new Date().toLocaleString()}. If this was not you, please contact the administrator immediately.`
    });

    if (getResetPasswordRequired(user.password_reset_required)) {
      return res.redirect("/change-password?forced=1");
    }

    return res.redirect(getDashboardRoute(user.role));
  } catch (err) {
    console.error("[LOGIN ERROR]", err);
    return res.redirect("/login?error=Unable+to+log+in");
  }
});

app.get("/signup", redirectIfLoggedIn, (req, res) => {
  res.render("auth/signup", { error: req.query.error || "" });
});

app.post("/signup", redirectIfLoggedIn, async (req, res) => {
  const { full_name, email, password, role } = req.body || {};

  if (!full_name || !email || !password) {
    return res.redirect("/signup?error=Please+fill+in+all+fields");
  }
  if (password.length < 6) {
    return res.redirect("/signup?error=Password+must+be+at+least+6+characters");
  }

  try {
    const normalizedEmail = email.trim().toLowerCase();
    const existingUser = await getUserByEmail(normalizedEmail);
    if (existingUser) return res.redirect("/signup?error=Email+already+registered");

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = await saveUser({
      full_name: full_name.trim(),
      email: normalizedEmail,
      password: hashedPassword,
      role: normalizeRole(role)
    });

    req.session.user = {
      id: newUser.id,
      full_name: newUser.full_name,
      email: newUser.email,
      role: normalizeRole(newUser.role)
    };

    await recordActivity({
      userId: newUser.id,
      userName: newUser.full_name,
      title: "New account created",
      detail: `${newUser.full_name} created a new account.`
    });

    await notifyUserByEmail({
      to: newUser.email,
      subject: 'Welcome to OIBL Schemes',
      text: `Hi ${newUser.full_name},\n\nYour account has been created successfully. You can now log in to the OIBL Schemes system and start managing your work.\n\nEmail: ${newUser.email}`
    });

    return res.redirect(getDashboardRoute(req.session.user.role));
  } catch (err) {
    console.error("[signup] Unexpected error:", err.message);
    return res.redirect("/signup?error=Unable+to+create+account.+Please+try+again");
  }
});

const requireSuperAdmin = (req, res, next) => {

  if (!req.session.user) {
    return res.redirect("/login");
  }

  if (req.session.user.role !== "Super Admin") {
    return res.redirect(getDashboardRoute(req.session.user.role));
  }

  next();
};

const getSystemPasswordLength = async () => {
  try {
    const [rows] = await db.query('SELECT password_length FROM system_settings ORDER BY created_at DESC LIMIT 1');
    return Number(rows[0]?.password_length || 8);
  } catch (err) {
    return 8;
  }
};

// ---------- Claims Routes ----------
const claimsRoutes = require('./routes/claims');

app.use('/claims', claimsRoutes);

const requireAdmin = (req, res, next) => {

  const role = normalizeRole(
    req.session.user?.role
  );

  if (
    role !== ROLES.SUPER_ADMIN && role !== ROLES.ADMIN
  ) {
    return res.redirect(
      getDashboardRoute(role)
    );
  }

  next();
};



const requireStaff = (req, res, next) => {

  const role = normalizeRole(req.session.user?.role);
  if (role !== ROLES.STAFF) {
    return res.redirect(
      getDashboardRoute(role)
    );
  }

  next();
};


app.get("/dashboard", requireAuth, (req, res) => {
  res.redirect(getDashboardRoute(req.session.user.role));
});

app.get("/staff-dashboard", requireAuth, async (req, res) => {
  if (normalizeRole(req.session.user.role) !== "Staff") {
    return res.redirect("/admin-dashboard");
  }

  const stats = await getDashboardStats(req.session.user);
  const activities = await getRecentActivities({
    userId: req.session.user.id,
    audience: "staff"
  });

  try {
    const [userProfile] = await db.query(
      'SELECT staff_id, full_name, email, bio, role FROM staff WHERE staff_id = ?',
      [req.session.user.id]
    );
    const profile = userProfile[0] || {};
    res.render("staff/dashboard", { user: req.session.user, stats, activities, profile });
  } catch (err) {
    console.error('[db] staff profile fetch failed:', err.message);
    res.render("staff/dashboard", { user: req.session.user, stats, activities, profile: {} });
  }
});

app.get("/admin-dashboard", requireAuth, async (req, res) => {
  if (normalizeRole(req.session.user.role) === "Staff") {
    return res.redirect("/staff-dashboard");
  }
  if (normalizeRole(req.session.user.role) === "Business Development Officer") {
    return res.redirect("/bdo-dashboard");
  }
  if (normalizeRole(req.session.user.role) === "Super Admin") {
    return res.redirect("/super-admin-dashboard");
  }

  const stats = await getDashboardStats(req.session.user);
  const activities = await getRecentActivities({ audience: "admin" });
  const formattedActivities = activities.map((activity) => ({
    title: activity.title,
    detail: activity.detail,
    time: new Date(activity.created_at).toLocaleString([], {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  }));

  try {
    const [userProfile] = await db.query(
      'SELECT staff_id, full_name, email, bio, role FROM staff WHERE staff_id = ?',
      [req.session.user.id]
    );
    const profile = userProfile[0] || {};
    res.render("Admin/admin",
       { user: req.session.user,
         stats, 
         activities: formattedActivities,
         profile });
  } catch (err) {
    console.error('[db] admin profile fetch failed:', err.message);
    res.render("Admin/admin", { user: req.session.user, stats, activities: formattedActivities, profile: {} });
  }
});

app.get("/bdo-dashboard", requireAuth, async (req, res) => {
  if (normalizeRole(req.session.user.role) !== "Business Development Officer") {
    return res.redirect(getDashboardRoute(req.session.user.role));
  }

  try {
    // User Profile
    const [userProfile] = await db.query(
      `SELECT staff_id, full_name, email, bio, role
       FROM staff
       WHERE staff_id = ?`,
      [req.session.user.id]
    );

    const profile = userProfile[0] || {};

    // KPI Statistics
    const [statsResult] = await db.query(`
      SELECT
        COUNT(*) AS totalSchemes,
        COUNT(*) AS totalProspects,
        SUM(CASE WHEN stage = 'Won' THEN 1 ELSE 0 END) AS wonSchemes,
        COALESCE(SUM(estimated_premium), 0) AS estimatedPremium
      FROM prospects
      WHERE created_by = ?
    `, [req.session.user.id]);

      const [[prospectCount]] = await db.query(`
        SELECT COUNT(*) AS totalProspects
        FROM prospects
        WHERE created_by = ?
        `, [req.session.user.id]);

        const [[schemeCount]] = await db.query(`
          SELECT COUNT(*) AS totalSchemes
          FROM schemes
          WHERE created_by = ?
          `, [req.session.user.id]);


    const statsRow = statsResult[0] || {};
    const [[wonRow]] = await db.query(`
    SELECT COUNT(*) AS wonSchemes
    FROM prospects
    WHERE LOWER(stage) = 'won'
    AND created_by = ?
`, [req.session.user.id]);


    // Pipeline Breakdown
    const [pipelineResult] = await db.query(`
SELECT
    SUM(CASE WHEN LOWER(stage) = 'lead' THEN 1 ELSE 0 END) AS leads,
    SUM(CASE WHEN LOWER(stage) = 'contacted' THEN 1 ELSE 0 END) AS contacted,
    SUM(CASE WHEN LOWER(stage) = 'proposal' THEN 1 ELSE 0 END) AS proposal,
    SUM(CASE WHEN LOWER(stage) = 'negotiation' THEN 1 ELSE 0 END) AS negotiation,
    SUM(CASE WHEN LOWER(stage) = 'won' THEN 1 ELSE 0 END) AS won
FROM prospects
WHERE created_by = ?
`, [req.session.user.id]);

    const pipelineRow = pipelineResult[0] || {};
    console.log('wonRow:', wonRow);

    res.render("BDO/dashboard", {
      user: req.session.user,
      profile,

      stats: {
        totalProspects: statsRow.totalProspects || 0,
        totalProspects: prospectCount.totalProspects || 0,
        totalSchemes: schemeCount.totalSchemes || 0,
        wonSchemes: wonRow.wonSchemes || 0,
        totalSchemes: statsRow.totalSchemes || 0,
        estimatedPremium: Number(
          statsRow.estimatedPremium || 0
        ).toLocaleString()
    },

      pipeline: {
        leads: pipelineRow.leads || 0,
        contacted: pipelineRow.contacted || 0,
        proposal: pipelineRow.proposal || 0,
        negotiation: pipelineRow.negotiation || 0,
        won: pipelineRow.wonSchemes || 0
      },

      prospects: [],
      followups: []
    });

  } catch (err) {
    console.error("[BDO Dashboard Error]:", err);
   



    res.render("BDO/dashboard", {
      user: req.session.user,
      profile: {},

      stats: {
        totalProspects: 0,
        totalSchemes: 0,
        wonSchemes: 0,
        estimatedPremium: 0
      },

      pipeline: {
        leads: 0,
        contacted: 0,
        proposal: 0,
        negotiation: 0,
        won: 0
      },

      prospects: [],
      followups: []
    });
  }
});

app.get("/admin/schemes/add-schemes", requireAuth, async (req, res) => {
  try {
    if (normalizeRole(req.session.user.role) === "Staff") {
      return res.redirect("/staff-dashboard");
    }

const [schemes] = await db.query(`
    SELECT
        s.scheme_id,
        s.scheme_name,
        s.insurer,
        s.policy_type,
        s.premium,
        s.inception_date,
        s.start_date,
        s.end_date,
        s.status,
        st.full_name AS assigned_to
    FROM schemes s
    LEFT JOIN scheme_allocations sa
        ON sa.scheme_id = s.scheme_id
    LEFT JOIN staff st
        ON st.staff_id = sa.staff_id
    ORDER BY s.created_at DESC
`);
    
    const [allocations] = await db.query(`SELECT staff_id FROM scheme_allocations`);
    const countByType = (type) =>
      schemes.filter((scheme) => scheme.policy_type === type).length;

    res.render("Admin/schemes/add_schemes", {
      schemes,
      medicalCover: countByType("Medical"),
      motorCover: countByType("Motor"),
      lifeCover: countByType("Life"),
      fireCover: countByType("Fire"),
      user: req.session.user,
    });
  } catch (err) {
    console.error("Error loading schemes:", err);
    res.status(500).send("Something went wrong while loading schemes.");
  }
});

app.post('/admin/schemes/add', requireAuth, async (req, res) => {
    const schemeValidation = validateSchemeInput(req.body);

    if (!schemeValidation.valid) {
      return res.status(400).send(schemeValidation.error);
    }

    const {
        scheme_name,
        insurer,
        policy_type,
        premium,
        inception_date,
        assigned_to,
        status
    } = schemeValidation.data;

    try {
      const assignedStaff = await resolveAssignedStaff(assigned_to);
      const assignedStaffName = assignedStaff ? assignedStaff.full_name : (assigned_to || null);

      const [result] = await db.query(
          `INSERT INTO schemes
          (scheme_name, status, insurer, policy_type, premium, inception_date, assigned_to, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
              scheme_name,
              normalizeSchemeStatus(status),
              insurer,
              policy_type,
              premium,
              inception_date || null,
              assignedStaffName,
              req.session.user?.id || null
          ]
      );

      await recordActivity({
        userId: req.session.user?.id || null,
        userName: req.session.user?.full_name || 'Admin',
        title: "Scheme created",
        detail: `${scheme_name} was uploaded and saved by ${req.session.user?.full_name || 'the administrator'}.`
      });

      if (req.session.user?.email) {
        await notifyUserByEmail({
          to: req.session.user.email,
          subject: 'Scheme created successfully',
          text: `Hi ${req.session.user.full_name},\n\nScheme "${scheme_name}" was created successfully in the OIBL Schemes system.`
        });
      }

      res.redirect('/admin/schemes/add-schemes');
    } catch (err) {
        console.error('[db] add scheme failed:', err.message);
        res.status(500).send('Unable to save scheme.');
    }
});

app.get('/admin/schemes/edit/:id', requireAuth, async (req, res) => {
  if (normalizeRole(req.session.user.role) === 'Staff') {
    return res.redirect('/staff-dashboard');
  }

  const schemeId = Number(req.params.id);
  if (!Number.isInteger(schemeId) || schemeId <= 0) {
    return res.status(400).send('Invalid scheme ID.');
  }

  try {
    const [rows] = await db.query(
      'SELECT * FROM schemes WHERE scheme_id = ? LIMIT 1',
      [schemeId]
    );
    if (!rows.length) return res.status(404).send('Scheme not found.');

    res.render('Admin/schemes/edit_scheme', {
      scheme: rows[0],
      user: req.session.user
    });
  } catch (err) {
    console.error('[db] load scheme for edit failed:', err.message);
    res.status(500).send('Unable to load scheme.');
  }
});

app.post('/admin/schemes/edit/:id', requireAuth, async (req, res) => {
  if (normalizeRole(req.session.user.role) === 'Staff') {
    return res.redirect('/staff-dashboard');
  }

  const schemeId = Number(req.params.id);
  if (!Number.isInteger(schemeId) || schemeId <= 0) {
    return res.status(400).send('Invalid scheme ID.');
  }

  const validation = validateSchemeInput(req.body);
  if (!validation.valid) {
    return res.status(400).send(validation.error);
  }

  const { scheme_name, insurer, policy_type, premium, inception_date, status, assigned_to } = validation.data;

  try {
    const assignedStaff = await resolveAssignedStaff(assigned_to);
    const assignedStaffName = assignedStaff ? assignedStaff.full_name : (assigned_to || null);

    const [result] = await db.query(
      `UPDATE schemes
       SET scheme_name = ?, insurer = ?, policy_type = ?, premium = ?, inception_date = ?, status = ?, assigned_to = ?
       WHERE scheme_id = ?`,
      [
        scheme_name,
        insurer || null,
        policy_type || null,
        premium === null ? null : premium,
        inception_date || null,
        normalizeSchemeStatus(status),
        assignedStaffName,
        schemeId
      ]
    );

    if (!result.affectedRows) return res.status(404).send('Scheme not found.');

    await recordActivity({
      userId: req.session.user.id,
      userName: req.session.user.full_name,
      title: 'Scheme updated',
      detail: `${scheme_name} was updated by ${req.session.user.full_name}.`
    });

    await notifyUserByEmail({
      to: req.session.user.email,
      subject: 'Scheme updated',
      text: `Hi ${req.session.user.full_name},\n\nScheme "${scheme_name}" was updated in the OIBL Schemes system.`
    });

    res.redirect('/admin/schemes/add-schemes');
  } catch (err) {
    console.error('[db] admin scheme update failed:', err.message);
    res.status(500).send('Unable to update scheme.');
  }
});

app.get('/admin/schemes/delete/:id', requireAuth, async (req, res) => {
  if (normalizeRole(req.session.user.role) === 'Staff') {
    return res.redirect('/staff-dashboard');
  }

  const schemeId = Number(req.params.id);
  if (!Number.isInteger(schemeId) || schemeId <= 0) {
    return res.status(400).send('Invalid scheme ID.');
  }

  try {
    const [rows] = await db.query(
      'SELECT scheme_name FROM schemes WHERE scheme_id = ? LIMIT 1',
      [schemeId]
    );
    if (!rows.length) return res.status(404).send('Scheme not found.');

    await db.query('DELETE FROM scheme_allocations WHERE scheme_id = ?', [schemeId]);
    await db.query('DELETE FROM schemes WHERE scheme_id = ?', [schemeId]);

    await recordActivity({
      userId: req.session.user.id,
      userName: req.session.user.full_name,
      title: 'Scheme deleted',
      detail: `${rows[0].scheme_name} was deleted by ${req.session.user.full_name}.`
    });

    await notifyUserByEmail({
      to: req.session.user.email,
      subject: 'Scheme deleted',
      text: `Hi ${req.session.user.full_name},\n\nScheme "${rows[0].scheme_name}" was deleted from the OIBL Schemes system.`
    });

    res.redirect('/admin/schemes/add-schemes');
  } catch (err) {
    console.error('[db] admin scheme deletion failed:', err.message);
    res.status(500).send('Unable to delete scheme.');
  }
});

app.post('/admin/schemes/delete/:id', async (req, res) => {
  try {
    const schemeId = req.params.id;

    // 1. Delete associated allocations first to avoid foreign key constraints
    await db.query('DELETE FROM scheme_allocations WHERE scheme_id = ?', [schemeId]);

    // 2. Delete the scheme
    await db.query('DELETE FROM schemes WHERE scheme_id = ?', [schemeId]);
    console.log('Scheme deleted ');
    // 3. Redirect back to the list view
    res.redirect('/admin/schemes/add-schemes');
    console.log('successfully redirected to scheme management');
  } catch (error) {
    console.error('Error deleting scheme:', error);
    res.status(500).send('Server Error');
  }
});


app.get("/admin/staff", requireAuth, async (req, res) => {
  if (normalizeRole(req.session.user.role) === "Staff") {
    return res.redirect("/staff-dashboard");
  }

  const staff = await getAllStaff();
  res.render("Admin/staff", { staff, user: req.session.user });
});

app.get("/staff/schemes", requireAuth, async (req, res) => {
  if (normalizeRole(req.session.user.role) !== "Staff") {
    return res.redirect("/admin-dashboard");
  }

  let schemes = [];
  try {
    [schemes] = await db.query(
      `SELECT s.scheme_id, s.scheme_name, s.insurer, s.policy_type,
              s.premium, s.inception_date, s.start_date, s.end_date,
              s.status, latest_allocation.allocated_at
       FROM schemes AS s
       INNER JOIN (
         SELECT scheme_id, MAX(allocated_at) AS allocated_at
         FROM scheme_allocations
         WHERE staff_id = ?
         GROUP BY scheme_id
       ) AS latest_allocation ON latest_allocation.scheme_id = s.scheme_id
       ORDER BY latest_allocation.allocated_at DESC, s.scheme_id DESC`,
      [req.session.user.id]
    );
  } catch (err) {
    console.error("[db] staff schemes query failed:", err.message);
  }

  res.render("staff/my_schemes", { schemes, user: req.session.user });
});

app.get("/staff/schemes/:id/edit", requireAuth, async (req, res) => {
  if (normalizeRole(req.session.user.role) !== "Staff") {
    return res.redirect("/admin-dashboard");
  }

  const [rows] = await db.query("SELECT * FROM schemes WHERE scheme_id = ?", [req.params.id]);
  const scheme = rows[0];

  if (!scheme) {
    return res.redirect("/staff/schemes");
  }

  const isAllowed =
    !scheme.assigned_to ||
    scheme.assigned_to === req.session.user.full_name ||
    scheme.assigned_to === req.session.user.email ||
    String(scheme.created_by) === String(req.session.user.id) ||
    (await db.query(
      "SELECT allocation_id FROM scheme_allocations WHERE scheme_id = ? AND staff_id = ? LIMIT 1",
      [req.params.id, req.session.user.id]
    ))[0].length > 0;

  if (!isAllowed) {
    return res.redirect("/staff/schemes");
  }

  res.render("staff/update_scheme", { scheme, user: req.session.user });
});

app.post("/staff/schemes/:id/update", requireAuth, async (req, res) => {
  if (normalizeRole(req.session.user.role) !== "Staff") {
    return res.redirect("/admin-dashboard");
  }

  const [rows] = await db.query("SELECT * FROM schemes WHERE scheme_id = ?", [req.params.id]);
  const scheme = rows[0];

  if (!scheme) {
    return res.redirect("/staff/schemes");
  }

  const isAllowed =
    !scheme.assigned_to ||
    scheme.assigned_to === req.session.user.full_name ||
    scheme.assigned_to === req.session.user.email ||
    String(scheme.created_by) === String(req.session.user.id) ||
    (await db.query(
      "SELECT allocation_id FROM scheme_allocations WHERE scheme_id = ? AND staff_id = ? LIMIT 1",
      [req.params.id, req.session.user.id]
    ))[0].length > 0;

  if (!isAllowed) {
    return res.redirect("/staff/schemes");
  }

  const {
    status,
    insurer,
    policy_type,
    premium,
    inception_date
  } = req.body;

  await db.query(
    `UPDATE schemes
     SET status = ?, insurer = ?, policy_type = ?, premium = ?, inception_date = ?
     WHERE scheme_id = ?`,
    [
      status || scheme.status,
      insurer || scheme.insurer || null,
      policy_type || scheme.policy_type || null,
      premium !== "" ? premium : scheme.premium,
      inception_date || scheme.inception_date || null,
      req.params.id
    ]
  );

  await recordActivity({
    userId: req.session.user.id,
    userName: req.session.user.full_name,
    title: "Scheme updated",
    detail: `${scheme.scheme_name} was updated by ${req.session.user.full_name}.`
  });

  await notifyUserByEmail({
    to: req.session.user.email,
    subject: 'Staff scheme update',
    text: `Hi ${req.session.user.full_name},\n\nYour update for scheme "${scheme.scheme_name}" has been saved successfully.`
  });

  res.redirect("/staff/schemes");
});


app.post("/admin/allocations", requireAuth, async (req, res) => {
  if (normalizeRole(req.session.user.role) === "Staff") {
    return res.redirect("/staff-dashboard");
  }

  const {
    scheme_id,
    allocation_date,
    remarks
  } = req.body;

  try {
    await db.query(
      `INSERT INTO scheme_allocations
       (scheme_id, allocated_to, allocation_date, remarks)
       VALUES (?, ?, ?, ?)`,
      [
        scheme_id,
        req.session.user.id,
        allocation_date,
        remarks
      ]
    );

    await recordActivity({
      userId: req.session.user.id,
      userName: req.session.user.full_name,
      title: "Scheme allocation created",
      detail: `An allocation was created for scheme ID ${scheme_id}.`
    });

    res.redirect("/staff/allocations");
  } catch (err) {
    console.error("[db] allocation failed:", err.message);
    res.status(500).send("Unable to save allocation.");
  }
});


app.get("/staff/allocations", requireAuth, async (req, res) => {
  if (normalizeRole(req.session.user.role) !== "Staff") {
    return res.redirect("/admin-dashboard");
  }

  let allocations = [];
  try {
    [allocations] = await db.query(
      `SELECT s.scheme_id, s.scheme_name, s.insurer, s.policy_type,
              s.status, s.inception_date, sa.allocated_at
       FROM scheme_allocations AS sa
       INNER JOIN schemes AS s ON s.scheme_id = sa.scheme_id
       WHERE sa.staff_id = ?
       ORDER BY sa.allocated_at DESC, sa.allocation_id DESC`,
      [req.session.user.id]
    );
  } catch (err) {
    console.error("[db] staff allocations query failed:", err.message);
  }

  res.render("staff/my_allocations", { allocations, user: req.session.user });
});

app.get("/staff/activity", requireAuth, async (req, res) => {
  if (normalizeRole(req.session.user.role) !== "Staff") {
    return res.redirect("/admin-dashboard");
  }

  const activities = await getRecentActivities({
    userId: req.session.user.id,
    audience: "staff"
  });

  const formattedActivities = activities.map((activity) => ({
    title: activity.title,
    detail: activity.detail,
    time: new Date(activity.created_at).toLocaleString([], {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  }));

  res.render("staff/activity", { activities: formattedActivities, user: req.session.user });
});

const renderAllocationPage = async (req, res, options = {}) => {
  const {
    error = '',
    selectedStaffId = '',
    selectedSchemeIds = []
  } = options;

  try {
    const [staff] = await pool.query(
      'SELECT staff_id, full_name, email FROM staff'
    );

    const [schemes] = await pool.query(
      'SELECT scheme_id, scheme_name FROM schemes'
    );

    const [allocations] = await pool.query(
      `SELECT scheme_allocations.allocation_id,
         scheme_allocations.scheme_id,
         scheme_name,
         insurer,
         policy_type,
         scheme_allocations.staff_id,
         full_name,
         schemes.status AS scheme_status,
         scheme_allocations.status AS allocation_status,
         scheme_allocations.allocated_at
      FROM scheme_allocations
      INNER JOIN schemes USING (scheme_id)
      INNER JOIN staff USING (staff_id)
      ORDER BY scheme_allocations.allocated_at DESC, scheme_allocations.allocation_id DESC;`
    );

    return res.status(error ? 400 : 200).render('Admin/schemes/allocations', {
      staff,
      schemes,
      allocations,
      user: req.session.user,
      error,
      selectedStaffId,
      selectedSchemeIds
    });
  } catch (err) {
    console.error(err);
    return res.status(500).send('Server Error');
  }
};

app.get('/admin/schemes/allocations', requireAuth, async (req, res) => {
  return renderAllocationPage(req, res);
});


;

app.post('/admin/schemes/allocations', requireAuth, async (req, res) => {
  if (normalizeRole(req.session.user.role) === 'Staff') {
    return res.redirect('/staff-dashboard');
  }

  const selectedStaffId = req.body.staff_id;
  const selectedSchemeIds = Array.isArray(req.body.scheme_ids)
    ? req.body.scheme_ids
    : req.body.scheme_ids
      ? [req.body.scheme_ids]
      : [];

  const validation = validateAllocationRequest(req.body);

  if (!validation.valid) {
    return renderAllocationPage(req, res, {
      error: validation.error,
      selectedStaffId,
      selectedSchemeIds
    });
  }

  const { staffId, schemeIds: uniqueSchemeIds } = validation;

  try {
    const [staffRows] = await db.query(
      `SELECT staff_id, full_name 
       FROM staff 
       WHERE staff_id = ? 
       LIMIT 1`,
      [staffId]
    );

    if (!staffRows.length) {
      return renderAllocationPage(req, res, {
        error: 'Selected staff member was not found.',
        selectedStaffId,
        selectedSchemeIds
      });
    }

    const staff = staffRows[0];

    for (const schemeId of uniqueSchemeIds) {
      const [schemeRows] = await db.query(
        `SELECT scheme_id, scheme_name
         FROM schemes
         WHERE scheme_id = ?`,
        [schemeId]
      );

      if (!schemeRows.length) continue;

      const scheme = schemeRows[0];

      try {
        // Insert allocation
        await db.query(
          `INSERT INTO scheme_allocations
            (staff_id, scheme_id, allocated_by, status)
           VALUES (?, ?, ?, 'Active')`,
          [staffId, schemeId, req.session.user.id]
        );

        // Update scheme assignment
        await db.query(
          `UPDATE schemes
           SET assigned_to = ?
           WHERE scheme_id = ?`,
          [staff.full_name, schemeId]
        );

        // Update staff schemes list
        await db.query(
          `UPDATE staff
           SET schemes =
             IF(
               schemes IS NULL OR schemes = '',
               ?,
               CONCAT(schemes, ', ', ?)
             )
           WHERE staff_id = ?`,
          [scheme.scheme_name, scheme.scheme_name, staffId]
        );

      } catch (insertErr) {
        if (insertErr.message.includes('Duplicate entry')) {
          return renderAllocationPage(req, res, {
            error: `${scheme.scheme_name} is already allocated.`,
            selectedStaffId,
            selectedSchemeIds
          });
        }

        throw insertErr;
      }
    }

    await recordActivity({
      userId: req.session.user.id,
      userName: req.session.user.full_name,
      title: 'Schemes allocated',
      detail: `${uniqueSchemeIds.length} scheme(s) allocated to ${staff.full_name}.`
    });

    if (staff.email) {
      await notifyUserByEmail({
        to: staff.email,
        subject: 'New scheme allocation',
        text: `Hi ${staff.full_name},\n\nYou have been assigned ${uniqueSchemeIds.length} new scheme(s) in the OIBL Schemes system. Please review them in your dashboard.`
      });
    }

    res.redirect('/admin/schemes/allocations');

  } catch (err) {
    console.error('[db] admin allocation failed:', err);
    res.status(500).send('Unable to save allocations.');
  }
});

const downloadWorkbook = async (res, workbook, fileName) => {
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  await workbook.xlsx.write(res);
  res.end();
};

const createReportWorkbook = (title, rows, columns) => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(title);

  sheet.columns = columns.map(({ header, key }) => ({ header, key }));

  rows.forEach((row) => {
    sheet.addRow(row);
  });

  return workbook;
};

app.get('/admin/reports', requireAuth, async (req, res) => {
  if (normalizeRole(req.session.user.role) === 'Staff') {
    return res.redirect('/staff-dashboard');
  }

console.log('BDO reports route loaded');


  let schemes = [];
  let staff = [];
  let allocations = [];

  try {
    [schemes] = await db.query('SELECT * FROM schemes ORDER BY created_at DESC');
  } catch (err) {
    console.error('[reports] schemes query failed:', err.message);
  }

  try {
    [staff] = await db.query('SELECT * FROM staff ORDER BY full_name ASC');
  } catch (err) {
    console.error('[reports] staff query failed:', err.message);
  }

  try {
    [allocations] = await db.query('SELECT * FROM scheme_allocations ORDER BY allocation_id DESC');
  } catch (err) {
    console.error('[reports] allocations query failed:', err.message);
    allocations = [];
  }

  const activeCount = schemes.filter((s) => s.status === 'Active').length;
  const inactiveCount = schemes.filter((s) => s.status === 'Inactive').length;

  res.render('Admin/reports', {
    schemes,
    staff,
    allocations,
    activeCount,
    inactiveCount,
    user: req.session.user
  });
});


app.get('/admin/bdo', requireAuth, async (req, res) => {
    try {

        const [bdos] = await db.query(`
            SELECT
                u.staff_id,
                u.full_name,

                COUNT(DISTINCT p.prospect_id) AS prospects,
                COUNT(DISTINCT s.scheme_id) AS schemes,

                COALESCE(SUM(p.estimated_premium),0) AS pipeline_value,
                COALESCE(SUM(s.premium),0) AS won_premium

            FROM staff u
            LEFT JOIN prospects p
                ON p.created_by = u.staff_id
            LEFT JOIN schemes s
                ON s.created_by = u.staff_id

            WHERE u.role = 'Business Development Officer'
            GROUP BY u.staff_id
            ORDER BY won_premium DESC
        `);
        const [prospects] = await db.query(`
            SELECT
                prospect_id,
                company_name,
                stage,
                estimated_premium,
                follow_up_date,
                p.contact_person as bdo_name

            FROM prospects p

            LEFT JOIN staff s
            ON s.staff_id=p.created_by

            ORDER BY p.created_at DESC
        `);

        const [stats] = await db.query(`
            SELECT
                (SELECT COUNT(*) FROM prospects) AS prospects,
                (SELECT COUNT(*) FROM schemes) AS schemes,
                (SELECT COALESCE(SUM(estimated_premium),0) FROM prospects) AS pipeline,
                (SELECT COALESCE(SUM(premium),0) FROM schemes) AS premium
        `);

        const [recentActivities] = await db.query(`
            SELECT
                p.company_name,
                p.stage,
                p.follow_up_date,
                p.contact_person AS bdo_name
            FROM prospects p
            LEFT JOIN staff u
                ON u.staff_id = p.created_by
            ORDER BY p.follow_up_date DESC
            LIMIT 20
        `);
        const [leaderboard] = await db.query(`
            SELECT
                u.staff_id,
                u.full_name,

                COUNT(DISTINCT p.prospect_id) prospects,

                COUNT(DISTINCT s.scheme_id) schemes,

                COALESCE(SUM(s.premium),0) premium

            FROM staff u

            LEFT JOIN prospects p
            ON p.created_by = u.staff_id

            LEFT JOIN schemes s
            ON s.created_by = u.staff_id

            WHERE u.role='BDO'

            GROUP BY u.staff_id

            ORDER BY s.premium DESC
            `);
       const [schemes] = await db.query(`
            SELECT
                scheme_id,
                scheme_name,
                company_name,
                premium,
                stage,
                s.created_by AS bdo_name

            FROM schemes s

            LEFT JOIN staff u
            ON s.created_by=u.staff_id
            `);

      const [allocations] = await db.query(`SELECT s.scheme_name,
              a.allocation_id

          FROM scheme_allocations a

          JOIN schemes s
          ON s.scheme_id=a.scheme_id

          JOIN staff u
          ON u.staff_id=a.allocated_to
          `);

      const [claims] = await db.query(`
          SELECT
              c.*,
              s.scheme_name

          FROM claims c

          JOIN schemes s
          ON s.scheme_id=c.scheme_id

          ORDER BY c.created_at DESC
          `);
        const [monthlyPremium] = await db.query(`
            SELECT
            MONTH(created_at) month,
            SUM(premium) premium

            FROM schemes

            GROUP BY MONTH(created_at)

            ORDER BY month
            `);
      const [conversion] = await db.query(`
         SELECT
             u.full_name,

          COUNT(DISTINCT p.prospect_id) prospects,

          COUNT(DISTINCT s.scheme_id) schemes,

          ROUND(
              (
                  COUNT(DISTINCT s.scheme_id) /
                  NULLIF(COUNT(DISTINCT p.prospect_id),0)
              ) * 100,
              2
          ) conversion_rate

        FROM staff u

        LEFT JOIN prospects p
        ON p.created_by=u.full_name

        LEFT JOIN schemes s
        ON s.created_by=u.full_name

        WHERE u.role='Business Development Officer'

        GROUP BY u.staff_id
        `);
        const [topOpportunities] = await db.query(`
            SELECT
            company_name,
            estimated_premium,
            stage

            FROM prospects

            ORDER BY estimated_premium DESC

            LIMIT 10
            `);
        res.render('admin/bdo', {
            title: 'BDO Dashboard',
            bdos,
            prospects,
            stats: stats[0],
            recentActivities,
            leaderboard,
            schemes,
            user: req.session.user
        });
      console.log(schemes)
      console.log(topOpportunities)

    } catch (error) {
        console.error(error);
        res.status(500).send('Error loading dashboard');
    }
});

app.get('/bdo/reports', requireAuth, async (req, res) => {
    if (normalizeRole(req.session.user.role) !== 'Business Development Officer') {
        return res.redirect(getDashboardRoute(req.session.user.role));
    }

    try {
        const userId = req.session.user.id;

        const [schemes] = await db.query(
            `SELECT *
             FROM schemes
             WHERE created_by = ?
             ORDER BY created_at DESC`,
            [userId]
        );

        const [prospects] = await db.query(
            `SELECT *
             FROM prospects
             WHERE created_by = ?
             ORDER BY created_at DESC`,
            [userId]
        );

        const [followups] = await db.query(
            `SELECT prospect_id, company_name, follow_up_date, stage
             FROM prospects
             WHERE created_by = ? AND follow_up_date IS NOT NULL
             ORDER BY follow_up_date ASC`,
            [userId]
        );

        const wonSchemes = prospects.filter((prospect) => String(prospect.stage || '').toLowerCase() === 'won').length;
        const estimatedPremium = prospects.reduce((sum, prospect) => sum + Number(prospect.estimated_premium || 0), 0);

        res.render('BDO/report', {
            user: req.session.user,
            schemes,
            prospects,
            followups,
            wonSchemes,
            totalSchemes: schemes.length,
            totalProspects: prospects.length,
            estimatedPremium
        });
    } catch (error) {
        console.error('[bdo reports] failed to load report data:', error);
        res.status(500).send('Unable to load BDO reports.');
    }
});

app.get('/bdo/reports/export-excel', requireAuth, async (req, res) => {
    if (normalizeRole(req.session.user.role) !== 'Business Development Officer') {
        return res.redirect(getDashboardRoute(req.session.user.role));
    }

    try {
        const userId = req.session.user.id;

        const [schemes] = await db.query(
            `SELECT scheme_id, scheme_name, status, insurer, policy_type, premium, inception_date, assigned_to, created_at
             FROM schemes
             WHERE created_by = ?
             ORDER BY created_at DESC`,
            [userId]
        );

        const [prospects] = await db.query(
            `SELECT prospect_id, company_name, contact_person, email, phone, stage, estimated_premium, follow_up_date, created_at
             FROM prospects
             WHERE created_by = ?
             ORDER BY created_at DESC`,
            [userId]
        );

        const workbook = new ExcelJS.Workbook();

        const schemesSheet = workbook.addWorksheet('Schemes');
        schemesSheet.columns = [
            { header: 'Scheme ID', key: 'scheme_id' },
            { header: 'Scheme Name', key: 'scheme_name' },
            { header: 'Status', key: 'status' },
            { header: 'Insurer', key: 'insurer' },
            { header: 'Policy Type', key: 'policy_type' },
            { header: 'Premium', key: 'premium' },
            { header: 'Inception Date', key: 'inception_date' },
            { header: 'Assigned To', key: 'assigned_to' },
            { header: 'Created At', key: 'created_at' }
        ];
        schemes.forEach((row) => schemesSheet.addRow(row));

        const prospectsSheet = workbook.addWorksheet('Prospects');
        prospectsSheet.columns = [
            { header: 'Prospect ID', key: 'prospect_id' },
            { header: 'Company Name', key: 'company_name' },
            { header: 'Contact Person', key: 'contact_person' },
            { header: 'Email', key: 'email' },
            { header: 'Phone', key: 'phone' },
            { header: 'Stage', key: 'stage' },
            { header: 'Estimated Premium', key: 'estimated_premium' },
            { header: 'Follow Up', key: 'follow_up_date' },
            { header: 'Created At', key: 'created_at' }
        ];
        prospects.forEach((row) => prospectsSheet.addRow(row));

        await downloadWorkbook(res, workbook, `bdo-report-${Date.now()}.xlsx`);
    } catch (error) {
        console.error('[bdo reports export] failed:', error);
        res.status(500).send('Unable to export BDO report.');
    }
});

app.get('/bdo/reports/schemes', requireAuth, async (req, res) => {
    return res.redirect('/bdo/reports');
});

app.get('/bdo/reports/prospects', requireAuth, async (req, res) => {
    return res.redirect('/bdo/reports');
});

app.get('/bdo/reports/followups', requireAuth, async (req, res) => {
    return res.redirect('/bdo/reports');
});


app.get('/admin/reports/schemes', requireAuth, async (req, res) => {
  if (normalizeRole(req.session.user.role) === 'Staff') {
    return res.redirect('/staff-dashboard');
  }

  const [schemes] = await db.query('SELECT * FROM schemes ORDER BY created_at DESC');
  const workbook = createReportWorkbook('Schemes', schemes, [
    { header: 'Scheme ID', key: 'scheme_id' },
    { header: 'Scheme Name', key: 'scheme_name' },
    { header: 'Status', key: 'status' },
    { header: 'Created By', key: 'created_by' },
    { header: 'Created At', key: 'created_at' }
  ]);

  await downloadWorkbook(res, workbook, 'schemes-report.xlsx');
});

app.get('/admin/reports/staff', requireAuth, async (req, res) => {
  if (normalizeRole(req.session.user.role) === 'Staff') {
    return res.redirect('/staff-dashboard');
  }

  const [staff] = await db.query('SELECT * FROM staff ORDER BY full_name ASC');
  const workbook = createReportWorkbook('Staff', staff, [
    { header: 'Staff ID', key: 'staff_id' },
    { header: 'Full Name', key: 'full_name' },
    { header: 'Email', key: 'email' },
    { header: 'Role', key: 'role' },
    { header: 'Status', key: 'status' }
  ]);

  await downloadWorkbook(res, workbook, 'staff-report.xlsx');
});

app.get('/admin/reports/allocations', requireAuth, async (req, res) => {
  if (normalizeRole(req.session.user.role) === 'Staff') {
    return res.redirect('/staff-dashboard');
  }

  let allocations = [];
  try {
    [allocations] = await db.query('SELECT * FROM scheme_allocations ORDER BY allocation_id DESC');
  } catch (err) {
    console.error('[reports] allocation export failed:', err.message);
    allocations = [];
  }

  const workbook = createReportWorkbook('Allocations', allocations, [
    { header: 'Allocation ID', key: 'allocation_id' },
    { header: 'Scheme ID', key: 'scheme_id' },
    { header: 'Staff ID', key: 'staff_id' },
    { header: 'Status', key: 'status' },
    { header: 'Assigned At', key: 'assigned_at' }
  ]);

  await downloadWorkbook(res, workbook, 'allocations-report.xlsx');
});

app.get('/admin/reports/export', requireAuth, async (req, res) => {
  if (normalizeRole(req.session.user.role) === 'Staff') {
    return res.redirect('/staff-dashboard');
  }

  let schemes = [];
  let staff = [];
  let allocations = [];

  try {
    [schemes] = await db.query('SELECT * FROM schemes ORDER BY created_at DESC');
  } catch (err) {
    console.error('[reports] export schemes query failed:', err.message);
  }

  try {
    [staff] = await db.query('SELECT * FROM staff ORDER BY full_name ASC');
  } catch (err) {
    console.error('[reports] export staff query failed:', err.message);
  }

  try {
    [allocations] = await db.query('SELECT * FROM scheme_allocations ORDER BY allocation_id DESC');
  } catch (err) {
    console.error('[reports] export allocations query failed:', err.message);
  }

  const workbook = new ExcelJS.Workbook();
  const schemesSheet = workbook.addWorksheet('Schemes');
  const staffSheet = workbook.addWorksheet('Staff');
  const allocationSheet = workbook.addWorksheet('Allocations');

  schemesSheet.columns = [
    { header: 'Scheme ID', key: 'scheme_id' },
    { header: 'Scheme Name', key: 'scheme_name' },
    { header: 'Status', key: 'status' },
    { header: 'Created By', key: 'created_by' },
    { header: 'Created At', key: 'created_at' }
  ];
  schemes.forEach((row) => schemesSheet.addRow(row));

  staffSheet.columns = [
    { header: 'Staff ID', key: 'staff_id' },
    { header: 'Full Name', key: 'full_name' },
    { header: 'Email', key: 'email' },
    { header: 'Role', key: 'role' },
    { header: 'Status', key: 'status' }
  ];
  staff.forEach((row) => staffSheet.addRow(row));

  allocationSheet.columns = [
    { header: 'Allocation ID', key: 'allocation_id' },
    { header: 'Scheme ID', key: 'scheme_id' },
    { header: 'Staff ID', key: 'staff_id' },
    { header: 'Status', key: 'status' },
    { header: 'Assigned At', key: 'assigned_at' }
  ];
  allocations.forEach((row) => allocationSheet.addRow(row));

  await downloadWorkbook(res, workbook, 'oibl-report.xlsx');
});

//new prospects route
app.get('/bdo/prospects/new', requireAuth, (req, res) => {

    if (normalizeRole(req.session.user.role) !== "Business Development Officer") {
        return res.redirect(getDashboardRoute(req.session.user.role));
    }

    res.render('bdo/new_prospects', {
        user: req.session.user,
        errors: [],
        success: null,
        prospects: [],
        user: req.session.user,
        stats: {
            leads: 0,
            contacted: 0,
            proposal: 0,
            negotiation: 0,
            won: 0
        },
        pipeline: {
            leads: 0,
            contacted: 0,
            proposal: 0,
            negotiation: 0,
            won: 0
        },
        followups: []
    });

});


 app.get('/bdo/prospects/edit/:id', requireAuth, async (req, res) => {
    if (normalizeRole(req.session.user.role) !== "Business Development Officer") {
        return res.redirect(getDashboardRoute(req.session.user.role));
    }

    try {
        const [rows] = await db.query(
            `SELECT * FROM prospects WHERE prospect_id = ?`,
            [req.params.id]
        );

        if (rows.length === 0) {
            return res.status(404).send('Prospect not found');
        }

        res.render('BDO/edit_prospects', {
            user: req.session.user,
            prospect: rows[0]
        });

    } catch (error) {
        console.error(error);
        res.status(500).send('Error loading prospect');
    }
});

app.get('/bdo/prospects', requireAuth, async (req, res) => {
    if (normalizeRole(req.session.user.role) !== "Business Development Officer") {
      return res.redirect(getDashboardRoute(req.session.user.role));
    }


const [prospects] = await db.query(`
    SELECT 
        p.*, 
 
        u.full_name AS bdo_name 
    FROM prospects p
    LEFT JOIN staff u ON u.staff_id = p.created_by
    WHERE p.stage != 'Won' OR p.stage IS NULL
    ORDER BY p.created_at DESC
`);

    const [pipeline] = await db.query(`SELECT SUM(estimated_premium) AS total_premium FROM prospects WHERE created_by = ?
`, [req.session.user.id]);

    const [followups] = await db.query(`SELECT COUNT(*) AS total_value
FROM prospects WHERE follow_up_date IS NOT NULL AND follow_up_date <= NOW()`);
const [retailProspects] = await db.query(`
            SELECT * FROM individual_prospects 
            ORDER BY created_at DESC
        `);
        const [corporateProspects] = await db.query(`
            SELECT * FROM prospects 
            ORDER BY created_at DESC
        `);

    res.render('BDO/prospects', {
        retailProspects,
        corporateProspects,
        prospects,
        wonSchemes: prospects.filter(p => p.stage === 'Won').length,
        totalSchemes: prospects.length,
        followups: followups[0]?.total_value || 0,
        pipeline: pipeline[0]?.total_premium || 0,
        user: req.session.user
    });
});

app.post('/bdo/prospects/create', requireAuth, async (req, res) => {
    try {
        if (normalizeRole(req.session.user.role) !== 'Business Development Officer') {
            return res.redirect(getDashboardRoute(req.session.user.role));
        }

        const customerType = req.body.customer_type;
        let displayName = '';

        // ============================
        // CORPORATE PROSPECT
        // ============================
        if (customerType === 'Corporate') {

            const productType = Array.isArray(req.body.product_type)
                ? req.body.product_type.join(', ')
                : req.body.product_type;

            const sql = `
                INSERT INTO prospects (
                    company_name,
                    industry,
                    location,
                    county,
                    contact_person,
                    phone,
                    email,
                    estimated_members,
                    estimated_premium,
                    stage,
                    follow_up_date,
                    remarks,
                    product_type,
                    created_by
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `;

            const values = [
                req.body.company_name || null,
                req.body.industry || null,
                req.body.location || null,
                req.body.county || null,
                req.body.contact_person || null,
                req.body.phone || null,
                req.body.email || null,
                req.body.estimated_members || 0,
                req.body.estimated_premium || 0,
                req.body.stage || 'Lead',
                req.body.follow_up_date || null,
                req.body.remarks || '',
                productType || null,
                req.session.user.id
            ];

            await db.query(sql, values);

            displayName = req.body.company_name;
        }

        // ============================
        // RETAIL / INDIVIDUAL PROSPECT
        // ============================
        else if (
            customerType === 'Retail' ||
            customerType === 'Individual'
        ) {

            const productType = Array.isArray(req.body.product_type)
                ? req.body.product_type.join(', ')
                : req.body.product_type;

            const sql = `
                INSERT INTO individual_prospects (
                    first_name,
                    last_name,
                    national_id,
                    date_of_birth,
                    phone,
                    email,
                    estimated_premium,
                    stage,
                    follow_up_date,
                    remarks,
                    product_type,
                    created_by
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `;

            const values = [
                req.body.first_name || null,
                req.body.last_name || null,
                req.body.national_id || null,
                req.body.date_of_birth || null,
                req.body.phone || null,
                req.body.email || null,
                req.body.estimated_premium || 0,
                req.body.stage || 'Lead',
                req.body.follow_up_date || null,
                req.body.remarks || null,
                productType || null,
                req.session.user.id
            ];

            console.log('Individual Prospect Values:', values);
            console.log('Value Count:', values.length);

            await db.query(sql, values);

            displayName = `${req.body.first_name || ''} ${req.body.last_name || ''}`.trim();
        }

        else {
            return res.status(400).send('Invalid customer type');
        }

        await recordActivity({
            userId: req.session.user.id,
            userName: req.session.user.full_name,
            title: 'New Prospect Created',
            detail: `${displayName} was added by ${req.session.user.full_name}`
        });

        res.redirect('/bdo/prospects');

    } catch (error) {
        console.error('Error creating prospect:', error);
        res.status(500).send('Failed to create prospect');
    }
});


app.post('/bdo/prospects/update/:id', requireAuth, async (req, res) => {
    if (normalizeRole(req.session.user.role) !== "Business Development Officer") {
        return res.redirect(getDashboardRoute(req.session.user.role));
    }

    try {

        await db.query(
            `
            UPDATE prospects
            SET
                contact_person = ?,
                company_name = ?,
                email = ?,
                phone = ?,
                location = ?,
                estimated_premium = ?,
                follow_up_date = ?,
                stage = ?
            WHERE prospect_id = ? AND created_by = ?`,
            [
                req.body.contact_person,
                req.body.company_name,
                req.body.email,
                req.body.phone,
                req.body.location,
                req.body.estimated_premium,
                req.body.follow_up_date,
                req.body.stage,
                req.params.id,
                req.session.user.id
            ]
        );

        res.redirect('/bdo/prospects');
    } catch (err) {
        console.error(err);
        res.status(500).send(err.message);
    }
});



app.post('/bdo/prospects/delete/:id', requireAuth, async (req, res) => {
    try {

        await db.query(
            `DELETE FROM prospects WHERE prospect_id = ?`,
            [req.params.id]
        );

        res.redirect('/bdo/prospects');

    } catch (error) {
        console.error(error);
        res.status(500).send('Failed to delete prospect');
    }
});


app.get('/bdo/schemes/create/:prospectId', requireAuth, async (req, res) => {
    if (normalizeRole(req.session.user.role) !== "Business Development Officer") {
        return res.redirect(getDashboardRoute(req.session.user.role));
    }

    try {
        const prospectId = Number.parseInt(req.params.prospectId, 10);
        if (!Number.isInteger(prospectId)) {
            return res.status(400).send('Invalid prospect ID.');
        }

        const [prospectRows] = await db.query(
            `SELECT * FROM prospects WHERE prospect_id = ?`,
            [prospectId]
        );

        if (!prospectRows.length) {
            return res.status(404).send('Prospect not found');
        }

        const prospect = prospectRows[0];
        const [existingSchemes] = await db.query(
            `SELECT scheme_id FROM schemes WHERE created_by = ? AND scheme_name = ? LIMIT 1`,
            [req.session.user.id, prospect.company_name || `Scheme-${prospectId}`]
        );

        if (existingSchemes.length > 0) {
            return res.redirect('/bdo/schemes?error=exists');
        }

        res.render('BDO/create_scheme', {
            title: `Convert ${prospect.company_name} to Scheme`,
            prospect,
            prospectId,
            user: req.session.user
        });

    } catch (error) {
        console.error('[GET /bdo/schemes/create/:prospectId Error]:', error);
        res.status(500).send('Error loading scheme creation form');
    }
});

app.post('/bdo/schemes/create/:prospectId', requireAuth, async (req, res) => {
    try {
        const prospectId = Number.parseInt(req.params.prospectId, 10);
        if (!Number.isInteger(prospectId)) {
            return res.status(400).send('Invalid prospect ID.');
        }

        const [prospectRows] = await db.query(
            `SELECT * FROM prospects WHERE prospect_id = ? AND created_by = ? LIMIT 1`,
            [prospectId, req.session.user.id]
        );

        if (!prospectRows.length) {
            return res.status(404).send('Prospect not found or not assigned to you.');
        }

        const prospect = prospectRows[0];
        const [existing] = await db.query(
            `SELECT scheme_id FROM schemes WHERE created_by = ? AND scheme_name = ? LIMIT 1`,
            [req.session.user.id, prospect.company_name || `Scheme-${prospectId}`]
        );

        if (existing.length) {
            return res.redirect('/bdo/schemes?error=exists');
        }

        const schemeName = String(req.body.scheme_name || `${prospect.company_name || 'Scheme'} - ${prospectId}`).trim();
        const productType = String(req.body.policy_type || req.body.product_type || 'Medical Insurance').trim();
        const premiumValue = req.body.premium === '' || req.body.premium === undefined || req.body.premium === null
            ? Number(prospect.estimated_premium || 0)
            : Number(req.body.premium);
        const status = normalizeSchemeStatus(req.body.status || 'New');

        await db.query(
            `INSERT INTO schemes
            (scheme_name, status, insurer, policy_type, premium, inception_date, assigned_to, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                schemeName,
                status,
                req.body.insurer || null,
                productType,
                Number.isFinite(premiumValue) ? premiumValue : 0,
                req.body.inception_date || null,
                req.session.user.full_name,
                req.session.user.id
            ]
        );

        await db.query(
            `UPDATE prospects SET stage = 'Won' WHERE prospect_id = ?`,
            [prospectId]
        );

        await recordActivity({
            userId: req.session.user.id,
            userName: req.session.user.full_name,
            title: 'Scheme Created',
            detail: `Converted prospect ${prospect.company_name} into scheme ${schemeName}`
        });

        res.redirect('/bdo/schemes?success=created');

    } catch (error) {
        console.error(error);
        res.status(500).send('Error creating scheme');
    }
});


app.get('/bdo/schemes', requireAuth, async (req, res) => {
    if (normalizeRole(req.session.user.role) !== "Business Development Officer") {
        return res.redirect(getDashboardRoute(req.session.user.role));
    }
    const search = req.query.search || '';
    const [[wonRow]] = await db.query(`
    SELECT COUNT(*) AS wonSchemes
    FROM prospects
    WHERE LOWER(stage) = 'won'
    AND created_by = ?
`, [req.session.user.id]);
    const prospectId = req.query.prospectId || null;

    const [schemes] = await db.query(`
        SELECT *
        FROM schemes
        ORDER BY created_at DESC
    `);

   const [premium] = await db.query(
    `SELECT COALESCE(SUM(premium), 0) AS totalPremium
     FROM schemes
     WHERE created_by = ?`,
    [req.session.user.id]
);

  // const wonScheme =  await db.query(`SELECT SUM(CASE WHEN stage = 'Won' THEN 1 ELSE 0 END) AS wonSchemes`);
  // const potential = await db.query(`SELECT COUNT(prospects)`)
  const [pipeline] = await db.query(`SELECT SUM(estimated_premium) AS total_premium FROM prospects WHERE created_by = ?
`, [req.session.user.id]);


console.log(premium[0].totalPremium);

    const stats = {
        total: schemes.length,
        potential: 0,
        won: 0,
        pipelineValue: pipeline
    };

    res.render('BDO/schemes', {
        schemes,
        prospectId,
        stats,
        user: req.session.user,
        search,
        premium,
        wonScheme: wonRow
    });
});

// 1. Convert Page via Query String: /bdo/convert?prospectId=5&type=Retail
app.get('/bdo/convert', requireAuth, async (req, res) => {
    try {
        const selectedId = req.query.prospectId;
        const customerType = req.query.type || 'Corporate'; // 'Corporate' or 'Retail'

        // Fetch both Corporate and Retail prospects for dropdown selectors
        const [corporateProspects] = await db.query(
            `SELECT *, 'Corporate' AS customer_type FROM prospects WHERE stage <> 'Won' ORDER BY created_at DESC`
        );
        const [retailProspects] = await db.query(
            `SELECT *, 'Retail' AS customer_type FROM individual_prospects WHERE stage <> 'Won' ORDER BY created_at DESC`
        );

        let prospect = null;

        if (selectedId) {
            if (customerType === 'Retail') {
                prospect = retailProspects.find(p => String(p.id) === String(selectedId)) || null;
            } else {
                prospect = corporateProspects.find(p => String(p.id || p.prospect_id) === String(selectedId)) || null;
            }
        }

        // Fallback to the first available prospect if none matched
        if (!prospect) {
            prospect = corporateProspects[0] || retailProspects[0] || null;
        }

        res.render('BDO/convert', {
            user: req.session.user,
            prospect: prospect,
            corporateProspects: corporateProspects,
            retailProspects: retailProspects,
            prospectId: selectedId || null,
            customerType: prospect ? (prospect.customer_type || customerType) : customerType
        });

    } catch (error) {
        console.error('Error loading conversion page:', error);
        res.status(500).send('Error loading conversion page');
    }
});

// 2. Direct Route Parameter: /bdo/convert/:type/:prospectId
app.get('/bdo/convert/:type/:prospectId', requireAuth, async (req, res) => {
    try {
        const { type, prospectId } = req.params;
        let rows = [];

        if (type.toLowerCase() === 'retail') {
            [rows] = await db.query('SELECT *, "Retail" AS customer_type FROM individual_prospects WHERE id = ?', [prospectId]);
        } else {
            [rows] = await db.query('SELECT *, "Corporate" AS customer_type FROM prospects WHERE id = ? OR prospect_id = ?', [prospectId, prospectId]);
        }

        if (!rows.length) {
            return res.status(404).send('Prospect not found');
        }

        res.render('BDO/convert', {
            user: req.session.user,
            prospect: rows[0],
            prospectId: prospectId,
            customerType: type
        });

    } catch (error) {
        console.error('Error loading conversion page:', error);
        res.status(500).send('Error loading conversion page');
    }
});

app.post('/bdo/convert/submit', requireAuth, async (req, res) => {
    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        const {
            prospect_id,
            prospect_type,
            policy_type,
            insurer_id,
            product_category,
            start_date,
            end_date,
            gross_written_premium,
            net_premium,
            statutory_levies,
            commission_rate_percent,
            bdo_commission_rate_percent,
            policy_number
        } = req.body;

        const createdBy = req.session.user.id;
        const policyNumber = String(policy_number || `POL-${Date.now()}`).trim() || `POL-${Date.now()}`;

        let clientRecord = null;

        if (prospect_type === 'Corporate') {
            const [rows] = await connection.query(
                `SELECT * FROM prospects WHERE prospect_id = ? FOR UPDATE`,
                [prospect_id]
            );

            if (!rows.length) throw new Error('Corporate prospect not found');

            const prospect = rows[0];
            clientRecord = {
                client_type: 'Corporate',
                company_or_full_name: prospect.company_name,
                registration_or_national_id: null,
                email: prospect.email,
                phone: prospect.phone,
                physical_address: `${prospect.location || ''}, ${prospect.county || ''}`.trim()
            };

            await connection.query(
                `UPDATE prospects SET stage = 'Won' WHERE prospect_id = ?`,
                [prospect_id]
            );
        } else if (prospect_type === 'Retail') {
            const [rows] = await connection.query(
                `SELECT * FROM individual_prospects WHERE id = ? FOR UPDATE`,
                [prospect_id]
            );

            if (!rows.length) throw new Error('Retail prospect not found');

            const prospect = rows[0];
            clientRecord = {
                client_type: 'Retail',
                company_or_full_name: `${prospect.first_name || ''} ${prospect.last_name || ''}`.trim(),
                registration_or_national_id: prospect.national_id || null,
                email: prospect.email,
                phone: prospect.phone,
                physical_address: null
            };

            await connection.query(
                `UPDATE individual_prospects SET stage = 'Won' WHERE id = ?`,
                [prospect_id]
            );
        } else {
            throw new Error('Invalid prospect type specified.');
        }

        let clientId;
        const [existingClient] = await connection.query(
            `SELECT id FROM clients_master WHERE email = ? LIMIT 1`,
            [clientRecord.email]
        );

        if (existingClient.length > 0) {
            clientId = existingClient[0].id;
        } else {
            const clientCode = `CLI-${new Date().getFullYear()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

            const [clientResult] = await connection.query(
                `INSERT INTO clients_master
                (client_code, client_type, company_or_full_name, registration_or_national_id, email, phone, physical_address)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                    clientCode,
                    clientRecord.client_type,
                    clientRecord.company_or_full_name,
                    clientRecord.registration_or_national_id,
                    clientRecord.email,
                    clientRecord.phone,
                    clientRecord.physical_address
                ]
            );

            clientId = clientResult.insertId;
        }

        const [policyResult] = await connection.query(
            `INSERT INTO active_policies (
                policy_number,
                client_id,
                insurer_id,
                product_category,
                start_date,
                end_date,
                gross_written_premium,
                net_premium,
                statutory_levies,
                status,
                prospect_type,
                source_prospect_id,
                created_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Active', ?, ?, ?)`,
            [
                policyNumber,
                clientId,
                insurer_id,
                product_category,
                start_date,
                end_date,
                Number(gross_written_premium || 0),
                Number(net_premium || 0),
                Number(statutory_levies || 0),
                prospect_type,
                prospect_id,
                createdBy
            ]
        );

        const policyId = policyResult.insertId;
        const commRate = parseFloat(commission_rate_percent || 0);
        const bdoCommRate = parseFloat(bdo_commission_rate_percent || 0);
        const grossPremium = parseFloat(gross_written_premium || 0);
        const expectedCommissionAmount = (grossPremium * commRate) / 100;
        const expectedBdoPayout = (expectedCommissionAmount * bdoCommRate) / 100;

        await connection.query(
            `INSERT INTO commission_schedules (
                policy_id,
                commission_rate_percent,
                expected_commission_amount,
                bdo_commission_rate_percent,
                expected_bdo_payout
            ) VALUES (?, ?, ?, ?, ?)`,
            [
                policyId,
                commRate,
                expectedCommissionAmount.toFixed(2),
                bdoCommRate,
                expectedBdoPayout.toFixed(2)
            ]
        );

        const policyEndDate = new Date(end_date);
        const renewalNoticeDate = new Date(policyEndDate);
        renewalNoticeDate.setDate(renewalNoticeDate.getDate() - 90);

        await connection.query(
            `INSERT INTO policy_renewals (
                policy_id,
                renewal_notice_date,
                expiry_date,
                status,
                assigned_bdo_id
            ) VALUES (?, ?, ?, 'Pending', ?)`,
            [
                policyId,
                renewalNoticeDate.toISOString().split('T')[0],
                end_date,
                createdBy
            ]
        );

        await connection.commit();

        req.flash('success_msg', `Policy ${policyNumber} successfully activated!`);
        res.redirect('/bdo/policies');
    } catch (error) {
        await connection.rollback();
        console.error('Policy Conversion Transaction Error:', error);
        res.status(500).send(`Failed to convert prospect to active policy: ${error.message}`);
    } finally {
        connection.release();
    }
});

// app.module.exports = router;


app.get('/bdo/schemes/update/:id', requireAuth, async (req, res) => {
    if (normalizeRole(req.session.user.role) !== "Business Development Officer") {
        return res.redirect(getDashboardRoute(req.session.user.role));
    }

    try {
        const [rows] = await db.query(
            `SELECT * FROM schemes WHERE scheme_id = ?`,
            [req.params.id]
        );

        if (!rows.length) {
            return res.status(404).send('Scheme not found');
        }

        res.render('BDO/edit_scheme', {
            scheme: rows[0],
            schemeId: req.params.id,
            user: req.session.user
        });

    } catch (error) {
        console.error(error);
        res.status(500).send('Error loading scheme');
    }
});

app.post('/bdo/schemes/update/:id', requireAuth, async (req, res) => {
    if (normalizeRole(req.session.user.role) !== "Business Development Officer") {
        return res.redirect(getDashboardRoute(req.session.user.role));
    }

    try {
        const schemeName = String(req.body.scheme_name || '').trim();
        if (!schemeName) {
            return res.status(400).send('Scheme name is required.');
        }

        const insurer = String(req.body.insurer || '').trim() || null;
        const policyType = String(req.body.policy_type || '').trim() || null;
        const premiumValue = req.body.premium === '' || req.body.premium === null || req.body.premium === undefined
            ? null
            : Number(req.body.premium);

        await db.query(
            `UPDATE schemes
             SET scheme_name = ?, insurer = ?, policy_type = ?, premium = ?, status = ?, inception_date = ?, assigned_to = ?
             WHERE scheme_id = ?`,
            [
                schemeName,
                insurer,
                policyType,
                Number.isFinite(premiumValue) ? premiumValue : null,
                req.body.status,
                req.body.inception_date || null,
                req.body.assigned_to || req.session.user.full_name,
                req.params.id
            ]
        );

        await recordActivity({
            userId: req.session.user.id,
            userName: req.session.user.full_name,
            title: "Scheme Updated",
            detail: `Scheme ${schemeName} was updated by ${req.session.user.full_name}.`
        });

        res.redirect('/bdo/schemes');

    } catch (error) {
        console.error(error);
        res.status(500).send('Failed to update scheme');
    }
});

app.post('/super-admin/users/reset-password/:id', requireSuperAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT staff_id, full_name, email FROM staff WHERE staff_id = ? LIMIT 1',
      [req.params.id]
    );

    if (!rows.length) {
      return res.redirect('/super-admin/users?error=User+not+found');
    }

    const targetUser = rows[0];
    const minimumLength = await getSystemPasswordLength();
    const temporaryPassword = generateTemporaryPassword(Math.max(12, minimumLength));

    const passwordUpdated = await updateUserPassword({
      staffId: targetUser.staff_id,
      password: temporaryPassword,
      forceReset: true
    });

    if (!passwordUpdated) {
      return res.redirect('/super-admin/users?error=Unable+to+reset+password');
    }

    await recordActivity({
      userId: req.session.user.id,
      userName: req.session.user.full_name,
      title: 'Password reset by administrator',
      detail: `${req.session.user.full_name} reset the password for ${targetUser.full_name}.`
    });

    const mailResult = await notifyUserByEmail({
      to: targetUser.email,
      subject: 'Your OIBL Schemes password was reset',
      text: `Hello ${targetUser.full_name},\n\nAn administrator reset your password.\n\nTemporary password: ${temporaryPassword}\n\nLog in with this temporary password and create a new password immediately.`,
      html: `<p>Hello ${targetUser.full_name},</p><p>An administrator reset your password.</p><p><strong>Temporary password:</strong> ${temporaryPassword}</p><p>Log in with this temporary password and create a new password immediately.</p>`
    });

    if (!mailResult.sent) {
      return res.redirect('/super-admin/users?error=Password+reset+but+email+delivery+failed');
    }

    return res.redirect('/super-admin/users?success=Password+reset+and+email+sent');
  } catch (err) {
    console.error('[super-admin reset-password]', err);
    return res.redirect('/super-admin/users?error=Unable+to+reset+password');
  }
});

app.get("/super-admin-dashboard",  requireSuperAdmin,
  async (req, res) => {

    try {

      const [[users]] =
        await db.query(
          "SELECT COUNT(*) total FROM staff"
        );

      const [[schemes]] =
        await db.query(
          "SELECT COUNT(*) total FROM schemes"
        );

      const [[allocations]] =
        await db.query(
          "SELECT COUNT(*) total FROM scheme_allocations"
        );

      const [[bdos]] =
        await db.query(
          `SELECT COUNT(*) total
           FROM staff
           WHERE role = 'Business Development Officer'`
        );

      const activities =
        await getRecentActivities();

      res.render(
        "super_admin/dashboard",
        {
          user: req.session.user,
          stats: {
            users: users.total,
            schemes: schemes.total,
            allocations: allocations.total,
            bdos: bdos.total
          },
          activities
        }
      );

    }catch (err) {

  console.error("SUPER ADMIN ERROR:");
  console.error(err);

  res.status(500).send(err.message);
}});

app.get('/super-admin/users', requireSuperAdmin, async (req, res) => {

    try {

        const [users] = await db.query(`
            SELECT
                staff_id,
                full_name,
                email,
                role,
                status,
                password_reset_required,
                created_at
            FROM staff
            ORDER BY created_at DESC
        `);

        res.render('super_admin/users', {
            users,
            user: req.session.user,
            error: req.query.error || '',
            success: req.query.success || ''
        });

    } catch (err) {

        console.error('[super-admin users]', err);

        res.status(500).send(
            'Unable to load users.'
        );

    }

});

app.get('/super-admin/users/new', requireSuperAdmin, (req, res) => {
  return res.redirect('/super-admin/users?error=Super+admin+cannot+add+new+users');
});

app.post('/super-admin/users/create', requireSuperAdmin, (req, res) => {
  return res.redirect('/super-admin/users?error=Super+admin+cannot+add+new+users');
});

// Edit User Page
app.get('/super-admin/users/edit/:id', requireSuperAdmin, async (req, res) => {
  try {
    const staffId = req.params.id;

    console.log('Editing User ID:', staffId);

    const [rows] = await db.query(
      'SELECT * FROM staff WHERE staff_id = ?',
      [staffId]
    );

    if (rows.length === 0) {
      return res.status(404).send(`User with ID ${staffId} not found`);
    }

    res.render('super_admin/edit_user', {
      selectedUser: rows[0],
      user: req.session.user
    });

  } catch (err) {
    console.error('Edit User Error:', err);
    res.status(500).send('Internal Server Error');
  }
});


app.get('/super-admin/users/deactivate/:id', requireSuperAdmin, async (req, res) => {
  try {
    const staffId = req.params.id;

    await db.query(
      `UPDATE staff
       SET status = 'Inactive'
       WHERE staff_id = ?`,
      [staffId]
    );

    await recordActivity({
      userId: req.session.user.id,
      userName: req.session.user.full_name,
      title: 'User Deactivated',
      detail: `Staff ID ${staffId} was deactivated`
    });

    res.redirect('/super-admin/users');

  } catch (err) {
    console.error('Deactivate User Error:', err);
    res.status(500).send('Unable to deactivate user');
  }
});


app.get('/super-admin/roles', requireSuperAdmin, async (req, res) => {

  res.render('super_admin/roles', {
    user: req.session.user
  });

});

app.get('/super-admin/audit', requireSuperAdmin, async (req, res) => {

  try {

    const [logs] = await db.query(
      `SELECT *
       FROM app_activity_log
       ORDER BY created_at DESC
       LIMIT 500`
    );

    res.render('super_admin/audit', {
      logs,
      user: req.session.user
    });

  } catch (err) {

    console.error(err);

    res.status(500).send(
      'Unable to load audit logs.'
    );

  }

});


app.get('/super-admin/settings', requireSuperAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT * FROM system_settings ORDER BY created_at DESC LIMIT 1'
    );

    const settings = rows[0] || {
      company_name: '',
      system_email: '',
      password_length: 8
    };

    res.render('super_admin/settings', {
      settings,
      user: req.session.user
    });

  } catch (err) {
    console.error('[super-admin settings]', err);

    res.render('super_admin/settings', {
      settings: {
        company_name: '',
        system_email: '',
        password_length: 8
      },
      user: req.session.user
    });
  }
});



app.post('/super-admin/settings/update',
requireSuperAdmin,
async (req, res) => {

  const {
    company_name,
    system_email,
    password_length
  } = req.body;

  await db.query(
    `UPDATE system_settings
     SET
       company_name = ?,
       system_email = ?,
       password_length = ?`,
    [
      company_name,
      system_email,
      password_length
    ]
  );

  await recordActivity({
    userId: req.session.user.id,
    userName: req.session.user.full_name,
    title: 'System Settings Updated',
    detail: 'System settings were modified.'
  });

  res.redirect('/super-admin/settings');

});


//bdo schemes
app.get('/schemes', async (req, res) => {
    // const Scheme = require('./models/Scheme');

    const [schemes] = await pool.query(
            'SELECT * FROM schemes ORDER BY created_at DESC'
        );

    const prospectId = req.query.prospectId || null;
      const search = (req.query.search || '').trim();

        let sql = 'SELECT * FROM schemes';
        const params = [];

        if (search) {
            sql += ` WHERE scheme_name LIKE ?
                     OR company_name LIKE ?
                     OR status LIKE ?`;
            const term = `%${search}%`;
            params.push(term, term, term);
        }

        sql += ' ORDER BY created_at DESC';


    res.render('bdo/schemes', {
        schemes,
        prospectId,
        stats: {
            total: 125,
            submitted: 78,
            approved: 30,
            pipelineValue: '25,400,000'
        }
    });

});


app.get('/admin/reports/export-excel', requireAuth, async (req, res) => {
  return res.redirect('/admin/reports/export');
});

app.post('/super-admin/users/update/:id',
requireSuperAdmin,
async (req, res) => {

    const {
        full_name,
        email,
        role,
        status,
        password,
        force_password_change
    } = req.body;

    try {
        const minLength = await getSystemPasswordLength();
        const targetUser = await getUserByEmail(String(email || '').trim().toLowerCase());

        let passwordResetRequired = !!force_password_change;

        if (password && password.trim() !== '') {
            if (password.length < minLength) {
                return res.redirect('/super-admin/users?error=Password+must+be+at+least+' + minLength + '+characters');
            }
            if (!passwordMeetsPolicy(password, minLength)) {
                return res.redirect('/super-admin/users?error=Password+must+include+letters+and+numbers');
            }

            passwordResetRequired = true;
            await updateUserPassword({
              staffId: req.params.id,
              password,
              forceReset: true
            });
        }

        await db.query(
            `UPDATE staff
             SET full_name = ?,
                 email = ?,
                 role = ?,
                 status = ?,
                 password_reset_required = ?
             WHERE staff_id = ?`,
            [
                full_name,
                email,
                role,
                status,
                passwordResetRequired ? 1 : 0,
                req.params.id
            ]
        );

        if (password && password.trim() !== '' && targetUser && targetUser.email) {
            await notifyUserByEmail({
              to: targetUser.email,
              subject: 'Password updated by administrator',
              text: `Hello ${targetUser.full_name},\n\nYour account password was updated by an administrator. Please log in and change it at your next login.\n\nEmail: ${targetUser.email}`
            });
        }

        await recordActivity({
            userId: req.session.user.id,
            userName: req.session.user.full_name,
            title: 'User updated',
            detail: `User ${full_name} was updated by ${req.session.user.full_name}.`
        });

        res.redirect('/super-admin/users');

    } catch (err) {

        console.error(err);
        res.status(500).send('Unable to update user.');

    }
});


app.post("/profile/update", requireAuth, async (req, res) => {
  const { bio } = req.body || {};
  const userId = req.session.user.id;

  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    await db.query(
      'UPDATE staff SET bio = ? WHERE staff_id = ?',
      [bio || null, userId]
    );

    await recordActivity({
      userId,
      userName: req.session.user.full_name,
      title: 'Profile updated',
      detail: `${req.session.user.full_name} updated their profile.`
    });

    res.json({ success: true, message: 'Profile updated successfully' });
  } catch (err) {
    console.error('[db] profile update failed:', err.message);
    res.status(500).json({ error: 'Unable to update profile' });
  }
});
app.get('/debug-session', (req, res) => {
  res.json({
    session: req.session.user || null
  });
});

app.get("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) console.error("[logout] error:", err);
    res.redirect("/login?success=You+have+been+logged+out");
  });
});

// Catch-all so a thrown error never just hangs the request
app.use((err, req, res, next) => {
  console.error("[unhandled] ", err);
  res.status(500).send("Something went wrong. Check the server console for details.");
});

// ---------- Start ----------
const HOST = process.env.HOST || "192.168.20.138";
app.listen(PORT, async () => {
  // console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Server running on http://${HOST}:${PORT}`);
  await initDb();
});