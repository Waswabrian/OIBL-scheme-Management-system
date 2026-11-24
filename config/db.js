// const mysql = require("mysql2");

// const connection = mysql.createConnection({
//   host: "localhost",
//   user: "root",
//   password: "",
//   database: "oibl_schemes"
// });

// module.exports = connection;

// config/db.js
// Requires: npm install mysql2 dotenv
require("dotenv").config();
const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host: process.env.DB_HOST || process.env.HOST || "localhost",
  user: process.env.DB_USER || process.env.USER || "root",
  password: process.env.DB_PASSWORD || process.env.PASSWORD || "",
  database: process.env.DB_NAME || process.env.DATABASE || "oibl_schemes",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Fail fast and loud on startup if credentials/host are wrong,
// instead of silently hanging on the first query.
pool
  .getConnection()
  .then((conn) => {
    console.log("[db] Pool connection test succeeded.");
    conn.release();
  })
  .catch((err) => {
    console.error("[db] Pool connection test failed:", err.message);
  });

module.exports = pool;