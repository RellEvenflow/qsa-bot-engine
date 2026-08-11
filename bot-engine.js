// Quantum Signal AI — Bot Execution Engine
// Runs on Railway 24/7

const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);
const resend = new Resend(process.env.RESEND_KEY);
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TWELVE_KEY = process.env.TWELVE_KEY || '9159b457e1f84232a39840dcbc9a6685';

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function sendTelegram(chatId, message) {
  if (!chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }),
    });
  } catch (e) { console.error('Telegram error:', e.message); }
}

async function sendEmail(to, subject, html) {
  try {
    await resend.emails.send({
      from: 'Quantum Signal AI <onboarding@resend.dev>',
      to, subject, html,
    });
  } catch (e) { console.error('Email error:', e.message); }
}

// ─── Indicators ───────────────────────────────────────────────────────────────
function calcEMA(data, period) {
  const k = 2 / (period + 1);
  let e = data[0];
  return data.map((v, i) => { e = i === 0 ? v : v * k + e * (1 - k); return e; });
}

function calcRSI(data, period = 14) {
  if (data.length <= period) return 50;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) {
    const d = data[i] - data[i - 1];
    d > 0 ? g += d : l -= d;
  }
  g /= period; l /= period;
  for (let i = period + 1; i < data.length; i++) {
    const d = data[i] - data[i - 1];
    const dg = d > 0 ? d : 0, dl = d < 0 ? -d : 0;
    g = (g * (period - 1) + dg) / period;
    l = (l * (period - 1) + dl) / period;
  }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}

function getSignal(closes) {
  if (closes.length < 30) return null;
  const e9  = calcEMA(closes, 9);
  const e21 = calcEMA(closes, 21);
  const rsi = calcRSI(closes);
  const n   = closes.length - 1;

  const emaCross = e9[n] > e21[n] && e9[n - 1] <= e21[n - 1];
  const emaDown  = e9[n] < e21[n] && e9[n - 1] >= e21[n - 1];
  const rsiSafe  = rsi > 30 && rsi < 65;
  const rsiOver  = rsi > 70;
  const rsiUnder = rsi < 30;

  let sig = null, confidence = 50;
  if (emaCross && rsiUnder)      { sig = 'HIGHLY ADVISED BUY'; confidence = 88; }
  else if (emaCross && rsiSafe)  { sig = 'STRONG BUY';         confidence = 78; }
  else if (emaDown && rsiOver)   { sig = 'SELL';               confidence = 75; }

  if (!sig) return null;

  const atr = Math.abs(closes[n] - closes[n - 1]);
  return {
    sig, confidence,
    price:      closes[n],
    stopLoss:   +(closes[n] - 1.5 * atr).toFixed(4),
    takeProfit: +(closes[n] + 2.0 * atr).toFixed(4),
  };
}

// ─── Fetch closes from Twelve Data ───────────────────────────────────────────
async function fetchCloses(symbol) {
  try {
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1h&outputsize=50&apikey=${TWELVE_KEY}`;
    const r = await fetch(url);
    const d = await r.json();
    if (d.status === 'error' || !d.values) return null;
    return d.values.map(v => parseFloat(v.close)).reverse();
  } catch { return null; }
}

// ─── Execute trade on Alpaca ──────────────────────────────────────────────────
async function executeAlpacaTrade(user, signal, symbol) {
  try {
    const baseUrl = 'https://api.alpaca.markets';
    const headers = {
      'APCA-API-KEY-ID': user.alpaca_key,
      'APCA-API-SECRET-KEY': user.alpaca_secret,
      'Content-Type': 'application/json',
    };

    // Get account equity
    const accountRes = await fetch(`${baseUrl}/v2/account`, { headers });
    const account = await accountRes.json();
    const equity = parseFloat(account.equity || 1000);
    const riskAmount = equity * ((user.risk_pct || 2) / 100);
    const qty = Math.max(0.001, +(riskAmount / signal.price).toFixed(6));

    const orderRes = await fetch(`${baseUrl}/v2/orders`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        symbol: symbol.replace('/', ''),
        qty: qty.toString(),
        side: signal.sig.includes('BUY') ? 'buy' : 'sell',
        type: 'market',
        time_in_force: 'gtc',
      }),
    });
    const order = await orderRes.json();
    if (order.id) return { qty, orderId: order.id, broker: 'alpaca' };
    return null;
  } catch (e) {
    console.error('Alpaca error:', e.message);
    return null;
  }
}

// ─── Notify user ─────────────────────────────────────────────────────────────
async function notifyUser(user, trade, signal) {
  const emoji = trade.type === 'BUY' ? '✅' : '💰';
  const telegramMsg = `
⚡ <b>QUANTUM SIGNAL AI</b>
${emoji} <b>${trade.type} EXECUTED</b>

<b>Pair:</b> ${trade.pair}
<b>Price:</b> $${signal.price?.toLocaleString()}
<b>Qty:</b> ${trade.quantity}
<b>Stop Loss:</b> $${signal.stopLoss}
<b>Take Profit:</b> $${signal.takeProfit}
<b>Signal:</b> ${signal.sig}
<b>Confidence:</b> ${signal.confidence}/100
<b>Broker:</b> ${trade.broker?.toUpperCase()}

⚠ Educational tool only. Not financial advice.
  `.trim();

  await sendTelegram(user.telegram_chat_id, telegramMsg);

  await sendEmail(
    user.email,
    `⚡ ${trade.type} ${trade.pair} — Quantum Signal AI`,
    `<div style="background:#030608;color:#a8c8e0;font-family:monospace;padding:40px;max-width:600px;">
      <h2 style="color:#00d4ff;">⬡ QUANTUM SIGNAL AI</h2>
      <h3 style="color:${trade.type === 'BUY' ? '#00ff88' : '#ff3355'};">${emoji} ${trade.type} EXECUTED — ${trade.pair}</h3>
      <p>Price: <strong style="color:#00d4ff;">$${signal.price?.toLocaleString()}</strong></p>
      <p>Signal: <strong style="color:#ffc400;">${signal.sig}</strong> (${signal.confidence}/100 confidence)</p>
      <p>Stop Loss: <strong style="color:#ff3355;">$${signal.stopLoss}</strong></p>
      <p>Take Profit: <strong style="color:#00ff88;">$${signal.takeProfit}</strong></p>
      <p>Broker: ${trade.broker?.toUpperCase()}</p>
      <p style="color:#2a5060;font-size:11px;margin-top:20px;">⚠ Educational tool only. Not financial advice.</p>
    </div>`
  );
}

// ─── Process signal for one user ─────────────────────────────────────────────
async function processUserSignal(user, symbol, signal) {
  // Check open trade count
  const { count } = await supabase
    .from('trades')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .eq('status', 'executed');

  if (count >= (user.max_trades || 3)) return;

  // Execute trade
  let result = null;
  if (user.alpaca_key && user.alpaca_secret) {
    result = await executeAlpacaTrade(user, signal, symbol);
  }

  if (!result) {
    console.log(`No broker connected for ${user.email}`);
    return;
  }

  // Save to DB
  const { data: trade } = await supabase.from('trades').insert({
    user_id: user.id,
    pair: symbol,
    type: signal.sig.includes('BUY') ? 'BUY' : 'SELL',
    price: signal.price,
    quantity: result.qty,
    signal: signal.sig,
    confidence: signal.confidence,
    status: 'executed',
    broker: result.broker,
  }).select().single();

  if (!trade) return;

  await notifyUser(user, trade, signal);
  console.log(`✅ Trade: ${trade.type} ${symbol} for ${user.email}`);
}

// ─── Main Bot Loop ────────────────────────────────────────────────────────────
const MARKETS = [
  'BTC/USD', 'ETH/USD', 'SOL/USD', 'XRP/USD',
  'EUR/USD', 'GBP/USD', 'USD/JPY',
  'XAU/USD', 'XAG/USD',
  'DJI', 'SPX', 'NDX',
];

async function runBotCycle() {
  console.log(`\n🤖 Bot cycle: ${new Date().toISOString()}`);

  const { data: users, error } = await supabase
    .from('users')
    .select('*')
    .eq('active', true)
    .eq('bot_active', true)
    .eq('plan', 'bot');

  if (error) { console.error('DB error:', error.message); return; }
  if (!users || users.length === 0) { console.log('No active bot users.'); return; }

  console.log(`${users.length} active bot users, checking ${MARKETS.length} markets...`);

  for (const symbol of MARKETS) {
    const closes = await fetchCloses(symbol);
    if (!closes || closes.length < 30) continue;

    const signal = getSignal(closes);
    if (!signal) continue;

    console.log(`Signal: ${signal.sig} on ${symbol} (${signal.confidence} confidence)`);

    await supabase.from('signals').insert({
      pair: symbol, type: signal.sig,
      confidence: signal.confidence, price: signal.price,
      stop_loss: signal.stopLoss, take_profit: signal.takeProfit,
    });

    for (const user of users) {
      await processUserSignal(user, symbol, signal);
      await new Promise(r => setTimeout(r, 300));
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log('✅ Cycle complete.');
}

// Start
console.log('🚀 Quantum Signal AI Bot Engine started');
runBotCycle();
setInterval(runBotCycle, 5 * 60 * 1000); // Every 5 minutes

process.on('uncaughtException', e => console.error('Error:', e.message));
process.on('unhandledRejection', e => console.error('Rejection:', e));

