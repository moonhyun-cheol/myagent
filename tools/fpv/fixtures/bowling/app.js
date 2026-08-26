"use strict";

const suits = ["♠", "♥", "♦", "♣"];
const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

const state = {
  deck: [],
  player: [],
  dealer: [],
  active: false,
  revealed: false,
  record: { wins: 0, losses: 0, draws: 0 },
};

const elements = {
  dealerCards: document.querySelector("#dealer-cards"),
  playerCards: document.querySelector("#player-cards"),
  dealerScore: document.querySelector("#dealer-score"),
  playerScore: document.querySelector("#player-score"),
  status: document.querySelector("#status-message"),
  start: document.querySelector("#start-button"),
  hit: document.querySelector("#hit-button"),
  stand: document.querySelector("#stand-button"),
  newGame: document.querySelector("#new-game-button"),
  wins: document.querySelector("#wins-count"),
  losses: document.querySelector("#losses-count"),
  draws: document.querySelector("#draws-count"),
};

function createDeck() {
  return suits.flatMap((suit) => ranks.map((rank) => ({ suit, rank }))).sort(() => Math.random() - 0.5);
}

function drawCard(hand) {
  const card = state.deck.pop();
  if (card) hand.push(card);
}

function handValue(hand) {
  let total = 0;
  let aces = 0;

  for (const card of hand) {
    if (card.rank === "A") {
      total += 11;
      aces += 1;
    } else if (["J", "Q", "K"].includes(card.rank)) {
      total += 10;
    } else {
      total += Number(card.rank);
    }
  }

  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return total;
}

function isBlackjack(hand) {
  return hand.length === 2 && handValue(hand) === 21;
}

function cardElement(card, hidden = false) {
  const element = document.createElement("div");
  element.className = hidden ? "card card-back" : `card ${["♥", "♦"].includes(card.suit) ? "red" : ""}`;

  if (!hidden) {
    element.innerHTML = `
      <span class="corner">${card.rank}<small>${card.suit}</small></span>
      <span class="suit">${card.suit}</span>
      <span class="corner bottom">${card.rank}<small>${card.suit}</small></span>
    `;
  }
  return element;
}

function renderCards(container, hand, hideFirstCard) {
  container.replaceChildren(...hand.map((card, index) => cardElement(card, hideFirstCard && index === 0)));
}

function render() {
  const playerValue = handValue(state.player);
  const dealerValue = handValue(state.dealer);
  const dealerHidden = state.active && !state.revealed;

  renderCards(elements.playerCards, state.player, false);
  renderCards(elements.dealerCards, state.dealer, dealerHidden);
  elements.playerScore.textContent = `점수: ${playerValue}`;
  elements.dealerScore.textContent = `점수: ${dealerHidden ? "?" : dealerValue}`;
  elements.hit.disabled = !state.active;
  elements.stand.disabled = !state.active;
  elements.start.textContent = state.active ? "진행 중" : "게임 시작";
  elements.start.disabled = state.active;
  elements.wins.textContent = state.record.wins;
  elements.losses.textContent = state.record.losses;
  elements.draws.textContent = state.record.draws;
}

function finish(message, outcome) {
  state.active = false;
  state.revealed = true;
  state.record[outcome] += 1;
  elements.status.textContent = message;
  render();
}

function settleRound() {
  const playerValue = handValue(state.player);
  const dealerValue = handValue(state.dealer);

  if (playerValue > 21) {
    finish(`버스트! ${playerValue}점으로 딜러 승리입니다.`, "losses");
  } else if (dealerValue > 21) {
    finish(`딜러 버스트! ${playerValue}점으로 승리했습니다.`, "wins");
  } else if (playerValue > dealerValue) {
    finish(`${playerValue} 대 ${dealerValue}, 승리했습니다!`, "wins");
  } else if (playerValue < dealerValue) {
    finish(`${playerValue} 대 ${dealerValue}, 딜러 승리입니다.`, "losses");
  } else {
    finish(`${playerValue} 대 ${dealerValue}, 무승부입니다.`, "draws");
  }
}

function startGame() {
  state.deck = createDeck();
  state.player = [];
  state.dealer = [];
  state.active = true;
  state.revealed = false;

  drawCard(state.player);
  drawCard(state.dealer);
  drawCard(state.player);
  drawCard(state.dealer);
  elements.status.textContent = "카드를 받았습니다. 히트 또는 스탠드를 선택하세요.";
  render();

  if (isBlackjack(state.player) || isBlackjack(state.dealer)) {
    state.revealed = true;
    if (isBlackjack(state.player) && isBlackjack(state.dealer)) {
      finish("양쪽 모두 블랙잭! 무승부입니다.", "draws");
    } else if (isBlackjack(state.player)) {
      finish("블랙잭! 승리했습니다.", "wins");
    } else {
      finish("딜러 블랙잭! 딜러 승리입니다.", "losses");
    }
  }
}

function hit() {
  if (!state.active) return;
  drawCard(state.player);
  const value = handValue(state.player);
  if (value > 21) {
    settleRound();
  } else {
    elements.status.textContent = `${value}점입니다. 계속 카드를 받을 수 있습니다.`;
    render();
  }
}

function stand() {
  if (!state.active) return;
  state.revealed = true;
  while (handValue(state.dealer) < 17) drawCard(state.dealer);
  settleRound();
}

function resetTable() {
  state.deck = [];
  state.player = [];
  state.dealer = [];
  state.active = false;
  state.revealed = false;
  elements.status.textContent = "새 게임을 시작해 주세요.";
  render();
}

elements.start.addEventListener("click", startGame);
elements.hit.addEventListener("click", hit);
elements.stand.addEventListener("click", stand);
elements.newGame.addEventListener("click", resetTable);

render();
