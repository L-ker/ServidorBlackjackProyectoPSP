const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { Worker } = require("worker_threads");
const { WebSocketServer, WebSocket } = require("ws");

const {
  initDatabase,
  createUser,
  findUserByUsername,
  saveGameResult,
  getHistoryByUserId,
  closeDatabase,
} = require("./db/database");

const HOST = "0.0.0.0";
const PORT = process.env.PORT || 8443;
const INITIAL_MONEY = 100;
const MAX_ROUNDS = 10;

const sessionsById = new Map();
const sessionIdBySocket = new Map();
let shuttingDown = false;

function sendMessage(socket, type, payload = {}, sessionId = undefined) {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }

  const message = { type, payload };
  if (sessionId) {
    message.sessionId = sessionId;
  }
  socket.send(JSON.stringify(message));
}

function parseMessage(rawData) {
  try {
    const parsed = JSON.parse(rawData.toString());
    if (!parsed || typeof parsed.type !== "string") {
      return null;
    }
    return parsed;
  } catch (error) {
    return null;
  }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  const [salt, hashHex] = String(storedHash || "").split(":");
  if (!salt || !hashHex) {
    return false;
  }

  const expectedHash = Buffer.from(hashHex, "hex");
  const candidateHash = crypto.scryptSync(password, salt, 64);

  if (expectedHash.length !== candidateHash.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedHash, candidateHash);
}

function normalizeCredentials(payload) {
  const username = String(payload?.username || "").trim();
  const password = String(payload?.password || "");
  return { username, password };
}

function createSession(user, socket) {
  const previousSessionId = sessionIdBySocket.get(socket);
  if (previousSessionId) {
    const previousSession = sessionsById.get(previousSessionId);
    if (previousSession) {
      void cleanupSession(previousSession, {
        cancelWorker: true,
        reason: "Nueva autenticacion en el mismo socket.",
      });
    }
  }

  const sessionId = crypto.randomBytes(32).toString("hex");
  const session = {
    sessionId,
    userId: user.id,
    username: user.username,
    socket,
    worker: null,
    createdAt: new Date().toISOString(),
  };

  sessionsById.set(sessionId, session);
  sessionIdBySocket.set(socket, sessionId);
  return session;
}

function validateSession(socket, sessionId) {
  if (!sessionId || typeof sessionId !== "string") {
    return { valid: false, reason: "sessionId obligatorio." };
  }

  const session = sessionsById.get(sessionId);
  if (!session) {
    return { valid: false, reason: "Sesion no encontrada o expirada." };
  }

  if (session.socket !== socket) {
    return { valid: false, reason: "La sesion no pertenece a este socket." };
  }

  return { valid: true, session };
}

async function cleanupSession(session, options = {}) {
  if (!session || !sessionsById.has(session.sessionId)) {
    return;
  }

  const { cancelWorker = false, reason = "Limpieza de sesion." } = options;

  sessionsById.delete(session.sessionId);
  if (sessionIdBySocket.get(session.socket) === session.sessionId) {
    sessionIdBySocket.delete(session.socket);
  }

  const worker = session.worker;
  session.worker = null;

  if (worker) {
    if (cancelWorker) {
      try {
        worker.postMessage({
          type: "CANCEL_GAME",
          payload: { reason },
        });
      } catch (error) {
        // Ignorado
      }
    }

    try {
      await worker.terminate();
    } catch (error) {
      // Ignorado
    }
  }
}

async function handleRegister(socket, payload) {
  const { username, password } = normalizeCredentials(payload);

  if (username.length < 3 || username.length > 30) {
    sendMessage(socket, "AUTH_ERROR", {
      message: "El usuario debe tener entre 3 y 30 caracteres.",
    });
    return;
  }

  if (password.length < 4 || password.length > 128) {
    sendMessage(socket, "AUTH_ERROR", {
      message: "La contrasena debe tener entre 4 y 128 caracteres.",
    });
    return;
  }

  const existing = await findUserByUsername(username);
  if (existing) {
    sendMessage(socket, "AUTH_ERROR", {
      message: "El usuario ya existe.",
    });
    return;
  }

  const passwordHash = hashPassword(password);
  await createUser(username, passwordHash);

  sendMessage(socket, "REGISTER", {
    message: "Registro completado. Ahora puedes iniciar sesion.",
  });
}

async function handleLogin(socket, payload) {
  const { username, password } = normalizeCredentials(payload);

  if (!username || !password) {
    sendMessage(socket, "AUTH_ERROR", {
      message: "Usuario y contrasena son obligatorios.",
    });
    return;
  }

  const user = await findUserByUsername(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    sendMessage(socket, "AUTH_ERROR", {
      message: "Credenciales incorrectas.",
    });
    return;
  }

  const session = createSession(user, socket);
  sendMessage(
    socket,
    "LOGIN_SUCCESS",
    {
      userId: user.id,
      username: user.username,
      createdAt: session.createdAt,
    },
    session.sessionId
  );
}

async function handleGetHistory(session) {
  const history = await getHistoryByUserId(session.userId);
  sendMessage(
    session.socket,
    "HISTORY_RESULT",
    {
      username: session.username,
      games: history,
    },
    session.sessionId
  );
}

function startGameForSession(session) {
  if (session.worker) {
    sendMessage(
      session.socket,
      "ERROR",
      { message: "Ya tienes una partida activa." },
      session.sessionId
    );
    return;
  }

  const worker = new Worker(path.join(__dirname, "workers", "gameWorker.js"), {
    workerData: {
      initialMoney: INITIAL_MONEY,
      maxRounds: MAX_ROUNDS,
    },
  });

  session.worker = worker;

  worker.on("message", async (workerMessage) => {
    const currentSession = sessionsById.get(session.sessionId);
    if (!currentSession || currentSession.worker !== worker) {
      return;
    }

    if (!workerMessage || typeof workerMessage.type !== "string") {
      sendMessage(currentSession.socket, "ERROR", {
        message: "Mensaje invalido desde worker.",
      });
      return;
    }

    if (workerMessage.type === "GAME_FINISHED") {
      sendMessage(
        currentSession.socket,
        "GAME_FINISHED",
        workerMessage.payload || {},
        currentSession.sessionId
      );

      try {
        await saveGameResult({
          userId: currentSession.userId,
          initialMoney:
            Number(workerMessage.payload?.initialMoney) || INITIAL_MONEY,
          finalMoney: Number(workerMessage.payload?.finalMoney) || 0,
          roundsPlayed: Number(workerMessage.payload?.roundsPlayed) || 0,
        });
      } catch (error) {
        sendMessage(
          currentSession.socket,
          "ERROR",
          { message: "No se pudo guardar la partida en la base de datos." },
          currentSession.sessionId
        );
      }

      await cleanupSession(currentSession, {
        cancelWorker: false,
        reason: "Partida terminada.",
      });
      return;
    }

    if (workerMessage.type === "GAME_ABORTED") {
      sendMessage(
        currentSession.socket,
        "GAME_ABORTED",
        workerMessage.payload || {},
        currentSession.sessionId
      );

      await cleanupSession(currentSession, {
        cancelWorker: false,
        reason: "Partida abortada.",
      });
      return;
    }

    sendMessage(
      currentSession.socket,
      workerMessage.type,
      workerMessage.payload || {},
      currentSession.sessionId
    );
  });

  worker.on("error", async (error) => {
    const currentSession = sessionsById.get(session.sessionId);
    if (!currentSession || currentSession.worker !== worker) {
      return;
    }

    sendMessage(
      currentSession.socket,
      "ERROR",
      { message: "Error interno en el worker de la partida." },
      currentSession.sessionId
    );

    await cleanupSession(currentSession, {
      cancelWorker: false,
      reason: `Worker error: ${error.message}`,
    });
  });

  worker.on("exit", () => {
    const currentSession = sessionsById.get(session.sessionId);
    if (!currentSession) {
      return;
    }

    if (currentSession.worker === worker) {
      currentSession.worker = null;
    }
  });
}

function forwardToWorker(session, messageType, payload = {}) {
  if (!session.worker) {
    sendMessage(
      session.socket,
      "ERROR",
      { message: "No hay partida activa para esta sesion." },
      session.sessionId
    );
    return;
  }

  try {
    session.worker.postMessage({
      type: messageType,
      payload,
    });
  } catch (error) {
    sendMessage(
      session.socket,
      "ERROR",
      { message: "No se pudo comunicar con el worker de juego." },
      session.sessionId
    );
  }
}

async function handleMessage(socket, rawData) {
  const message = parseMessage(rawData);
  if (!message) {
    sendMessage(socket, "ERROR", {
      message: "Mensaje JSON invalido o formato incorrecto.",
    });
    return;
  }

  if (message.type === "REGISTER") {
    await handleRegister(socket, message.payload || {});
    return;
  }

  if (message.type === "LOGIN") {
    await handleLogin(socket, message.payload || {});
    return;
  }

  const validation = validateSession(socket, message.sessionId);
  if (!validation.valid) {
    sendMessage(socket, "ERROR", { message: validation.reason });
    try {
      socket.close(1008, "Invalid session");
    } catch (error) {
      // Socket ya cerrado
    }
    return;
  }

  const session = validation.session;

  switch (message.type) {
    case "START_GAME":
      startGameForSession(session);
      break;
    case "PLACE_BET":
      forwardToWorker(session, "PLACE_BET", {
        amount: message.payload?.amount,
      });
      break;
    case "PLAYER_ACTION":
      forwardToWorker(session, "PLAYER_ACTION", {
        action: String(message.payload?.action || "").toUpperCase(),
      });
      break;
    case "GET_HISTORY":
      await handleGetHistory(session);
      break;
    default:
      sendMessage(socket, "ERROR", {
        message: "Tipo de mensaje no soportado.",
      }, session.sessionId);
      break;
  }
}

async function gracefulShutdown(httpServer, wss) {
  if (shuttingDown) return;
  shuttingDown = true;

  const sessions = Array.from(sessionsById.values());
  for (const session of sessions) {
    await cleanupSession(session, {
      cancelWorker: true,
      reason: "Servidor en apagado.",
    });
  }

  wss.close();
  await closeDatabase();

  httpServer.close(() => process.exit(0));
}

async function bootstrap() {
  await initDatabase();

  const httpServer = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Blackjack WSS server running.\n");
  });

  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (socket) => {
    socket.on("message", async (rawData) => {
      try {
        await handleMessage(socket, rawData);
      } catch (error) {
        sendMessage(socket, "ERROR", {
          message: "Error interno procesando el mensaje.",
        });
      }
    });

    socket.on("close", () => {
      const sessionId = sessionIdBySocket.get(socket);
      if (!sessionId) return;

      const session = sessionsById.get(sessionId);
      if (session) {
        void cleanupSession(session, {
          cancelWorker: true,
          reason: "Socket cerrado por el cliente.",
        });
      }
    });
  });

  httpServer.listen(PORT, HOST, () => {
    console.log(`Servidor en http://${HOST}:${PORT}`);
  });

  process.on("SIGINT", () => void gracefulShutdown(httpServer, wss));
  process.on("SIGTERM", () => void gracefulShutdown(httpServer, wss));
}

bootstrap().catch((error) => {
  console.error("Error al iniciar:", error.message);
  process.exit(1);
});
