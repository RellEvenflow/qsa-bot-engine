// ─── Quantum Signal AI — Bot Execution Engine ────────────────────────────────
// Deploy this on Railway as a separate Node.js service
// It runs 24/7, monitors signals, and executes trades on user broker accounts

import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';
import Alpaca from '@alpacahq/alpaca-trade-api';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
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
      from: 'Quantum Signal AI <noreply@quantumsignalai.com>',
      to, subject, html,
    });
  } catch (e) { console.error('Email error:', e.message); }
}

function tradeEmailHtml(trade, user) {
  const color = trade.type === 'BUY' ? '#00ff88' : '#ff3355';
  return `
    <div style="background:#030608;color:#a8c8e0;font-family:monospace;padding:40px;max-width:600px;margin:0 auto;">
      <h2 style="color:#00d4ff;">⬡ QUANTUM SIGNAL AI</h2>
      <h3 style="color:${color};">${trade.type === 'BUY' ? '✅' : '💰'} TRADE ${trade.status === 'executed' ? 'EXECUTED' : 'UPDATE'}</h3>
      <div style="background:#080f14;border:1px solid #0c1e2e;border-radius:8px;padding:20px;margin:16px 0;">
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="color:#3a6070;padding:4px 0;">Pair</td><td style="color:#fff;text-align:right;">${trade.pair}</td></tr>
          <tr><td style="color:#3a6070;padding:4px 0;">Type</td><td style="color:${color};text-align:right;font-weight:700;">${trade.type}</td></tr>
          <tr><td style="color:#3a6070;padding:4px 0;">Price</td><td style="color:#00d4ff;text-align:right;">$${trade.price?.toLocaleString()}</td></tr>
          <tr><td style="color:#3a6070;padding:4px 0;">Quantity</td><td style="color:#fff;text-align:right;">${trade.quantity}</td></tr>
          <tr><td style="color:#3a6070;padding:4px 0;">Signal</td><td style="color:#ffc400;text-align:right;">${trade.signal}</td></tr>
          <tr><td style="color:#3a6070;padding:4px 0;">Confidence</td><td style="color:#a855f7;text-align:right;">${trade.confidence}/100</td></tr>
          ${trade.pnl ? `<tr><td style="color:#3a6070;padding:4px 0;">P&L</td><td style="color:#00ff88;text-align:right;font-weight:700;">+$${trade.pnl}</td></tr>` : ''}
          <tr><td style="color:#3a6070;padding:4px 0;">Broker</td><td style="color:#fff;text-align:right;">${trade.broker}</td></tr>
        </table>
      </div>
      <p style="color:#2a5060;font-size:11px;">⚠ Educational tool only. Not financial advice. Trades execute on your own broker account.</p>
    </div>
  `;
}

// ─── Indicator Calculations ───────────────────────────────────────────────────
function calcEMA(data, period) {
  const k = 2 / (period + 1); let e = data[0];
  return data.map((v, i) => { e = i === 0 ? v : v * k + e * (1 - k); return e; });
}

function calcRSI(data, period = 14) {
  if (data.length <= period) return 50;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) { const d = data[i] - data[i-1]; d > 0 ? g += d : l -= d; }
  g /= period; l /= period;
  for (let i = period + 1; i < data.length; i++) {
    const d = data[i] - data[i-1], dg = d > 0 ? d : 0, dl = d < 0 ? -d : 0;
    g = (g * (period - 1) + dg) / period; l = (l * (period - 1) + dl) / period;
  }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}

function getSignal(closes) {
  if (closes.length < 30) return null;
  const e9  = calcEMA(closes, 9);
  const e21 = calcEMA(closes, 21);
  const rsi = calcRSI(closes);
  const n   = closes.length - 1;

  const emaCross  = e9[n] > e21[n] && e9[n-1] <= e21[n-1];
  const emaDown   = e9[n] < e21[n] && e9[n-1] >= e21[n-1];
  const rsiSafe   = rsi > 30 && rsi < 65;
  const rsiOver   = rsi > 70;
  const rsiUnder  = rsi < 30;

  let sig = null, confidence = 50;
  if (emaCross && rsiSafe)  { sig = 'BUY';        confidence = 72; }
  if (emaCross && rsiUnder) { sig = 'HIGHLY ADVISED BUY'; confidence = 88; }
  if (emaCross && rsiSafe && rsiUnder === false && e9[n] > e21[n]) { sig = 'STRONG BUY'; confidence = 91; }
  if (emaDown  && rsiOver)  { sig = 'SELL';        confidence = 75; }

  const atr = Math.abs(closes[n] - closes[n-1]);
  return sig ? { sig, confidence, price: closes[n], stopLoss: closes[n] - 1.5 * atr, takeProfit: closes[n] + 2 * atr } : null;
}

// ─── Fetch live prices from Twelve Data ───────────────────────────────────────
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
    const alpaca = new Alpaca({
      keyId: user.alpaca_key,
      secretKey: user.alpaca_secret,
      paper: false, // Set to true for paper trading
    });

    const account = await alpaca.getAccount();
    const equity = parseFloat(account.equity);
    const riskAmount = equity * (user.risk_pct / 100);
    const qty = Math.floor(riskAmount / signal.price * 100) / 100;

    if (qty <= 0) return null;

    const order = await alpaca.createOrder({
      symbol: symbol.replace('/', ''),
      qty,
      side: signal.sig.includes('BUY') ? 'buy' : 'sell',
      type: 'market',
      time_in_force: 'gtc',
    });

    return { qty, orderId: order.id, broker: 'alpaca' };
  } catch (e) {
    console.error('Alpaca error:', e.message);
    return null;
  }
}

// ─── Execute trade on Coinbase ────────────────────────────────────────────────
async function executeCoinbaseTrade(user, signal, symbol) {
  try {
    // Coinbase Advanced Trade API
    const productId = symbol.replace('/', '-');
    const url = 'https://api.coinbase.com/api/v3/brokerage/orders';

    const body = {
      client_order_id: `qsa_${Date.now()}`,
      product_id: productId,
      side: signal.sig.includes('BUY') ? 'BUY' : 'SELL',
      order_configuration: {
        market_market_ioc: {
          quote_size: '100', // $100 per trade for now
        }
      }
    };

    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${user.coinbase_key}`,
      },
      body: JSON.stringify(body),
    });

    const d = await r.json();
    if (!d.success) throw new Error(d.error_response?.message || 'Coinbase order failed');

    return { qty: 100 / signal.price, orderId: d.order_id, broker: 'coinbase' };
  } catch (e) {
    console.error('Coinbase error:', e.message);
    return null;
  }
}

// ─── Process signal for a user ────────────────────────────────────────────────
async function processUserSignal(user, symbol, signal) {
  // Count open trades
  const { count } = await supabase
    .from('trades')
    .select('*', { count: 'exact' })
    .eq('user_id', user.id)
    .eq('status', 'executed');

  if (count >= user.max_trades) {
    console.log(`User ${user.email} at max trades (${count}/${user.max_trades})`);
    return;
  }

  // Only trade on strong signals if user preference
  const threshold = user.signal_threshold || 'strong';
  if (threshold === 'strong' && !['STRONG BUY', 'HIGHLY ADVISED BUY', 'HIGHLY ADVISED SELL'].includes(signal.sig)) return;

  // Execute on broker
  let result = null;
  if (user.alpaca_key && user.alpaca_secret) {
    result = await executeAlpacaTrade(user, signal, symbol);
  } else if (user.coinbase_key && user.coinbase_secret) {
    result = await executeCoinbaseTrade(user, signal, symbol);
  }

  if (!result) return;

  // Log trade to database
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

  // Send Telegram notification
  const telegramMsg = `
⚡ <b>QUANTUM SIGNAL AI</b>
${signal.sig.includes('BUY') ? '✅ BUY EXECUTED' : '💰 SELL EXECUTED'}

<b>Pair:</b> ${symbol}
<b>Type:</b> ${trade.type}
<b>Price:</b> $${signal.price?.toLocaleString()}
<b>Qty:</b> ${result.qty}
<b>Stop Loss:</b> $${signal.stopLoss?.toFixed(2)}
<b>Take Profit:</b> $${signal.takeProfit?.toFixed(2)}
<b>Signal:</b> ${signal.sig}
<b>Confidence:</b> ${signal.confidence}/100
<b>Broker:</b> ${result.broker.toUpperCase()}
`;

  await sendTelegram(user.telegram_chat_id, telegramMsg);

  // Send email notification
  await sendEmail(
    user.email,
    `⚡ ${trade.type} ${symbol} — Quantum Signal AI`,
    tradeEmailHtml(trade, user)
  );

  console.log(`✅ Trade executed: ${trade.type} ${symbol} for ${user.email}`);
}

// ─── Main Bot Loop ────────────────────────────────────────────────────────────
const MARKETS = [
  'BTC/USD', 'ETH/USD', 'SOL/USD',
  'EUR/USD', 'GBP/USD', 'USD/JPY',
  'XAU/USD', 'DJI', 'SPX', 'NDX',
];

async function runBotCycle() {
  console.log(`\n🤖 Bot cycle started: ${new Date().toISOString()}`);

  // Get all active bot users
  const { data: users } = await supabase
    .from('users')
    .select('*')
    .eq('active', true)
    .eq('bot_active', true)
    .eq('plan', 'bot');

  if (!users || users.length === 0) {
    console.log('No active bot users found.');
    return;
  }

  console.log(`Processing ${users.length} active bot users across ${MARKETS.length} markets...`);

  // Check each market for signals
  for (const symbol of MARKETS) {
    const closes = await fetchCloses(symbol);
    if (!closes || closes.length < 30) continue;

    const signal = getSignal(closes);
    if (!signal) continue;

    console.log(`Signal found: ${signal.sig} on ${symbol} (confidence: ${signal.confidence})`);

    // Save signal to DB
    await supabase.from('signals').insert({
      pair: symbol,
      type: signal.sig,
      confidence: signal.confidence,
      price: signal.price,
      stop_loss: signal.stopLoss,
      take_profit: signal.takeProfit,
    });

    // Execute for each eligible user
    for (const user of users) {
      await processUserSignal(user, symbol, signal);
      await new Promise(r => setTimeout(r, 500)); // Rate limit between users
    }

    await new Promise(r => setTimeout(r, 1000)); // Rate limit between markets
  }

  console.log('✅ Bot cycle complete.');
}

// ─── Start Engine ─────────────────────────────────────────────────────────────
console.log('🚀 Quantum Signal AI Bot Engine starting...');
runBotCycle();

// Run every 5 minutes
setInterval(runBotCycle, 5 * 60 * 1000);

// Keep alive
process.on('uncaughtException', err => console.error('Uncaught:', err.message));
process.on('unhandledRejection', err => console.error('Unhandled:', err));

