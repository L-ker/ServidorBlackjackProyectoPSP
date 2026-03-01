const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const dbPath = path.join(__dirname, "blackjack.sqlite");
const db = new sqlite3.Database(dbPath);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) {
        reject(error);
        return;
      }

      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(row || null);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(rows || []);
    });
  });
}

async function initDatabase() {
  await run("PRAGMA foreign_keys = ON");

  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS games (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      initial_money INTEGER NOT NULL,
      final_money INTEGER NOT NULL,
      rounds_played INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
}

async function createUser(username, passwordHash) {
  const result = await run(
    "INSERT INTO users (username, password_hash) VALUES (?, ?)",
    [username, passwordHash]
  );

  return result.lastID;
}

function findUserByUsername(username) {
  return get(
    "SELECT id, username, password_hash FROM users WHERE username = ?",
    [username]
  );
}

async function saveGameResult(gameResult) {
  const { userId, initialMoney, finalMoney, roundsPlayed } = gameResult;

  const result = await run(
    `
      INSERT INTO games (user_id, initial_money, final_money, rounds_played)
      VALUES (?, ?, ?, ?)
    `,
    [userId, initialMoney, finalMoney, roundsPlayed]
  );

  return result.lastID;
}

function getHistoryByUserId(userId) {
  return all(
    `
      SELECT id, initial_money, final_money, rounds_played, created_at
      FROM games
      WHERE user_id = ?
      ORDER BY created_at DESC, id DESC
    `,
    [userId]
  );
}

function closeDatabase() {
  return new Promise((resolve, reject) => {
    db.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

module.exports = {
  initDatabase,
  createUser,
  findUserByUsername,
  saveGameResult,
  getHistoryByUserId,
  closeDatabase,
};
