const { parentPort, workerData } = require("worker_threads");
const crypto = require("crypto");

const INITIAL_MONEY = Number(workerData?.initialMoney) || 100;
const MAX_ROUNDS = Number(workerData?.maxRounds) || 10;

const SUITS = ["Hearts", "Diamonds", "Clubs", "Spades"];
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

const state = {
  initialMoney: INITIAL_MONEY,
  money: INITIAL_MONEY,
  maxRounds: MAX_ROUNDS,
  roundsPlayed: 0,
  currentBet: 0,
  phase: "WAITING_BET",
  deck: [],
  playerHand: [],
  dealerHand: [],
  finished: false,
  aborted: false,
};

function send(type, payload = {}) {
  parentPort.postMessage({ type, payload });
}

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit });
    }
  }
  return deck;
}

function shuffleDeck(deck) {
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function drawCard() {
  return state.deck.pop();
}

function cardLabel(card) {
  return `${card.rank}${card.suit.charAt(0)}`;
}

function serializeCard(card) {
  return { ...card, label: cardLabel(card) };
}

function serializeHand(hand) {
  return hand.map(serializeCard);
}

function handValue(hand) {
  let total = 0;
  let aces = 0;

  for (const card of hand) {
    if (card.rank === "A") {
      total += 1;
      aces += 1;
    } else if (["J", "Q", "K"].includes(card.rank)) {
      total += 10;
    } else {
      total += Number(card.rank);
    }
  }

  while (aces > 0 && total + 10 <= 21) {
    total += 10;
    aces -= 1;
  }

  return total;
}

function visibleDealerValue() {
  if (state.dealerHand.length === 0) {
    return 0;
  }
  return handValue([state.dealerHand[0]]);
}

function canRequestNewRound() {
  return state.money > 0 && state.roundsPlayed < state.maxRounds;
}

function requestBet() {
  if (!canRequestNewRound()) {
    finishGame();
    return;
  }

  state.roundsPlayed += 1;
  state.currentBet = 0;
  state.phase = "WAITING_BET";
  state.deck = [];
  state.playerHand = [];
  state.dealerHand = [];

  send("REQUEST_BET", {
    round: state.roundsPlayed,
    maxRounds: state.maxRounds,
    money: state.money,
  });
}

function sendRoundState(revealDealer = false) {
  send("ROUND_STATE", {
    round: state.roundsPlayed,
    money: state.money,
    bet: state.currentBet,
    playerHand: serializeHand(state.playerHand),
    dealerHand: revealDealer
      ? serializeHand(state.dealerHand)
      : [serializeCard(state.dealerHand[0]), { hidden: true }],
    playerValue: handValue(state.playerHand),
    dealerValue: revealDealer ? handValue(state.dealerHand) : visibleDealerValue(),
    canAct: state.phase === "PLAYER_TURN",
  });
}

function rejectBet(message) {
  send("BET_REJECTED", {
    round: state.roundsPlayed,
    money: state.money,
    reason: message,
  });
}

function placeBet(rawAmount) {
  if (state.finished || state.aborted) {
    return;
  }

  if (state.phase !== "WAITING_BET") {
    rejectBet("No se puede apostar en este momento.");
    return;
  }

  const amount = Number(rawAmount);
  if (!Number.isInteger(amount) || amount <= 0) {
    rejectBet("La apuesta debe ser un entero positivo.");
    return;
  }

  if (amount > state.money) {
    rejectBet("No tienes dinero suficiente para esa apuesta.");
    return;
  }

  state.currentBet = amount;
  state.deck = shuffleDeck(createDeck());
  state.playerHand = [drawCard(), drawCard()];
  state.dealerHand = [drawCard(), drawCard()];
  state.phase = "PLAYER_TURN";

  send("BET_ACCEPTED", {
    round: state.roundsPlayed,
    money: state.money,
    bet: state.currentBet,
  });

  sendRoundState(false);

  if (handValue(state.playerHand) === 21) {
    dealerTurnAndResolve();
  }
}

function dealerTurnAndResolve() {
  state.phase = "DEALER_TURN";

  while (handValue(state.dealerHand) < 17) {
    state.dealerHand.push(drawCard());
  }

  resolveRound();
}

function resolveRound() {
  const playerScore = handValue(state.playerHand);
  const dealerScore = handValue(state.dealerHand);
  let result = "PUSH";
  let moneyDelta = 0;

  if (playerScore > 21) {
    result = "DEALER_WIN";
    moneyDelta = -state.currentBet;
  } else if (dealerScore > 21) {
    result = "PLAYER_WIN";
    moneyDelta = state.currentBet;
  } else if (playerScore > dealerScore) {
    result = "PLAYER_WIN";
    moneyDelta = state.currentBet;
  } else if (playerScore < dealerScore) {
    result = "DEALER_WIN";
    moneyDelta = -state.currentBet;
  }

  state.money += moneyDelta;
  state.phase = "ROUND_RESOLVED";

  sendRoundState(true);

  send("ROUND_RESULT", {
    round: state.roundsPlayed,
    result,
    bet: state.currentBet,
    playerValue: playerScore,
    dealerValue: dealerScore,
    moneyAfterRound: state.money,
  });

  if (canRequestNewRound()) {
    requestBet();
  } else {
    finishGame();
  }
}

function handlePlayerAction(action) {
  if (state.finished || state.aborted) {
    return;
  }

  if (state.phase !== "PLAYER_TURN") {
    send("ERROR", { message: "No puedes jugar una accion en este momento." });
    return;
  }

  if (action === "HIT") {
    state.playerHand.push(drawCard());
    const score = handValue(state.playerHand);

    if (score > 21) {
      dealerTurnAndResolve();
      return;
    }

    if (score === 21) {
      dealerTurnAndResolve();
      return;
    }

    sendRoundState(false);
    return;
  }

  if (action === "STAND") {
    dealerTurnAndResolve();
    return;
  }

  send("ERROR", { message: "Accion no valida. Usa HIT o STAND." });
}

function finishGame() {
  if (state.finished || state.aborted) {
    return;
  }

  state.finished = true;
  state.phase = "FINISHED";

  send("GAME_FINISHED", {
    initialMoney: state.initialMoney,
    finalMoney: state.money,
    roundsPlayed: state.roundsPlayed,
  });
}

function abortGame(reason) {
  if (state.finished || state.aborted) {
    return;
  }

  state.aborted = true;
  state.phase = "ABORTED";

  send("GAME_ABORTED", {
    reason: reason || "Partida cancelada.",
  });
}

parentPort.on("message", (message) => {
  if (!message || typeof message.type !== "string") {
    send("ERROR", { message: "Mensaje del hilo principal invalido." });
    return;
  }

  switch (message.type) {
    case "PLACE_BET":
      placeBet(message.payload?.amount);
      break;
    case "PLAYER_ACTION":
      handlePlayerAction(message.payload?.action);
      break;
    case "CANCEL_GAME":
      abortGame(message.payload?.reason || "Partida cancelada por desconexion.");
      break;
    default:
      send("ERROR", { message: "Tipo de mensaje no soportado en worker." });
      break;
  }
});

requestBet();
