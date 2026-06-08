/**
 * Fund Insight Pro - 基金智能分析平台
 * Backend API Server (Pure HTTP Rewrite - No CLI dependencies)
 * 直接请求东方财富/天天基金等公开 HTTP API
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');

const app = express();
const PORT = process.env.PORT || 3210;

// 代理支持：本地环境自动检测 HTTP_PROXY
const proxyUrl = process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || null;
const httpAgent = proxyUrl ? new HttpProxyAgent(proxyUrl) : undefined;
const httpsAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ==================== HTTP 工具 ====================

/**
 * HTTP GET 请求（返回 Promise 字符串）
 */
function httpGet(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https');
    const client = isHttps ? https : http;
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.eastmoney.com/',
        ...opts.headers,
      },
      timeout: opts.timeout || 12000,
      agent: isHttps ? httpsAgent : httpAgent,
    };
    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    req.on('error', reject);
    req.end();
  });
}

/**
 * HTTP GET 返回 JSON（带重试）
 */
async function httpGetJSON(url, opts = {}, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const raw = await httpGet(url, opts);
      return JSON.parse(raw);
    } catch (e) {
      lastErr = e;
      if (i < retries) await new Promise(r => setTimeout(r, 300));
    }
  }
  throw lastErr;
}

// ==================== 代码规范化 ====================

/**
 * 股票代码规范化：裸6位数字 → 带市场前缀
 * 规则：6/5/9开头→sh，0/3开头→sz，4/8开头→bj
 */
function normalizeCode(code) {
  if (!code) return code;
  const c = code.toLowerCase().trim();
  if (/^(sh|sz|bj)/.test(c)) return c;
  if (/^\d{6}$/.test(c)) {
    if (c.startsWith('6') || c.startsWith('5') || c.startsWith('9')) return `sh${c}`;
    if (c.startsWith('0') || c.startsWith('3')) return `sz${c}`;
    if (c.startsWith('4') || c.startsWith('8')) return `bj${c}`;
    return `sh${c}`;
  }
  return c;
}

/**
 * 代码 → eastmoney 市场代码
 * sh → 1, sz → 0, bj → 0
 */
function codeToMarket(code) {
  const c = code.toLowerCase().trim();
  if (c.startsWith('sh')) return '1';
  if (c.startsWith('sz')) return '0';
  if (c.startsWith('bj')) return '0';
  if (/^\d{6}$/.test(code)) {
    if (code.startsWith('6') || code.startsWith('5') || code.startsWith('9')) return '1';
    return '0';
  }
  return '1';
}

/**
 * 从带前缀代码中提取纯数字代码
 */
function codeToNumeric(code) {
  return code.toLowerCase().replace(/^(sh|sz|bj)/, '');
}

// ==================== API 响应工具 ====================

function ok(data, meta = {}) {
  return { code: 0, data, meta: { ts: new Date().toISOString(), ...meta } };
}

function fail(msg, code = 500) {
  return { code, message: msg, data: null };
}

// ==================== 东方财富行情 API ====================

/**
 * 批量获取股票行情（push2 API）
 * 返回对象数组，字段使用中文名（与前端一致）
 */
async function fetchStockQuote(codes) {
  const codeList = codes.split(',').map(c => c.trim()).filter(Boolean);
  const results = [];

  for (const code of codeList) {
    const normalized = normalizeCode(code);
    const market = codeToMarket(normalized);
    const numCode = codeToNumeric(normalized);
    const secid = `${market}.${numCode}`;

    try {
      const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f44,f45,f46,f47,f48,f50,f51,f52,f57,f58,f60,f116,f117,f162,f167,f168,f169,f170,f171,f55`;
      const json = await httpGetJSON(url, { headers: { 'Referer': 'https://quote.eastmoney.com/' } });
      const d = json && json.data;
      if (!d) continue;

      results.push({
        code: normalized,
        代码: d.f57 || numCode,
        名称: d.f58 || '--',
        最新价: +(d.f43 / 100).toFixed(2),
        '涨幅%': +(d.f170 / 100).toFixed(2),
        涨跌额: +(d.f169 / 100).toFixed(2),
        开盘: +(d.f46 / 100).toFixed(2),
        最高: +(d.f44 / 100).toFixed(2),
        最低: +(d.f45 / 100).toFixed(2),
        昨收: +(d.f60 / 100).toFixed(2),
        成交量: d.f47 || 0,
        成交额: d.f48 || 0,
        '换手率%': +(d.f167 / 100).toFixed(2),
        总市值: d.f116 || 0,
        流通市值: d.f117 || d.f168 || 0,
        市盈率: +(d.f162 / 100).toFixed(2),
        总股本: d.f55 || 0,
        量比: +(d.f50 / 100).toFixed(2),
        涨停价: +(d.f51 / 100).toFixed(2),
        跌停价: +(d.f52 / 100).toFixed(2),
        振幅: +(d.f171 / 100).toFixed(2),
      });
    } catch (e) {
      console.error(`[Quote] ${secid} 获取失败:`, e.message);
    }
  }
  return results;
}

/**
 * 获取个股K线数据
 * period: day|week|month → klt: 101|102|103
 */
async function fetchStockKline(code, period = 'day', limit = 120) {
  const normalized = normalizeCode(code);
  const market = codeToMarket(normalized);
  const numCode = codeToNumeric(normalized);
  const secid = `${market}.${numCode}`;

  const kltMap = { day: '101', week: '102', month: '103' };
  const klt = kltMap[period] || '101';

  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=${klt}&fqt=0&end=20500101&lmt=${Math.min(limit, 1000)}`;
  const json = await httpGetJSON(url, { headers: { 'Referer': 'https://quote.eastmoney.com/' } });

  const result = { name: '', preClose: 0, klines: [] };
  if (!json || !json.data) return result;

  result.name = json.data.name || '';
  result.preClose = json.data.preKPrice || 0;

  const klines = json.data.klines || [];
  result.klines = klines.map(line => {
    const p = line.split(',');
    // "日期,开盘,收盘,最高,最低,成交量,成交额,振幅,涨跌幅,涨跌额,换手率"
    return {
      日期: p[0],
      开盘: +p[1] || 0,
      收盘: +p[2] || 0,
      最高: +p[3] || 0,
      最低: +p[4] || 0,
      成交量: +p[5] || 0,
      成交额: +p[6] || 0,
      '振幅%': +p[7] || 0,
      '涨跌幅%': +p[8] || 0,
      涨跌额: +p[9] || 0,
      '换手率%': +p[10] || 0,
    };
  });

  return result;
}

/**
 * 获取板块K线（用于涨跌计算）
 */
async function fetchSectorKline(sectorCode, limit = 2) {
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=90.${sectorCode}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=0&end=20500101&lmt=${limit}`;
  try {
    const json = await httpGetJSON(url, { headers: { 'Referer': 'https://quote.eastmoney.com/' }, timeout: 8000 });
    if (!json || !json.data || !json.data.klines) return [];
    return json.data.klines.map(line => {
      const p = line.split(',');
      return { 日期: p[0], 开盘: +p[1] || 0, 收盘: +p[2] || 0, 最高: +p[3] || 0, 最低: +p[4] || 0, 成交量: +p[5] || 0, 成交额: +p[6] || 0 };
    });
  } catch (e) {
    console.error(`[SectorKline] ${sectorCode} error:`, e.message);
    return [];
  }
}

// ==================== 行业板块数据 ====================

/** 热门行业板块BK代码（东方财富行业板块） */
const HOT_SECTOR_BKS = [
  'BK0478','BK0473','BK0474','BK0481','BK0467','BK0458',
  'BK0459','BK0457','BK0482','BK0466','BK0471','BK0470',
  'BK0475','BK0476','BK0479','BK0472','BK0484','BK0483',
  'BK0463','BK0462','BK0461','BK0465','BK0464','BK0469',
  'BK0468','BK0480','BK0485','BK0489','BK0486','BK0487','BK0488',
];

/**
 * 批量获取板块实时行情（一次请求，返回含名称+涨跌幅）
 */
async function fetchSectorQuotes(bkCodes) {
  const secids = bkCodes.map(b => `90.${b}`).join(',');
  const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=f2,f3,f12,f14,f43,f60,f169,f170&secids=${secids}`;
  const json = await httpGetJSON(url, { headers: { Referer:'https://quote.eastmoney.com/' }, timeout: 15000 });
  const arr = json?.data?.diff || [];
  return arr.map(d => ({
    code: d.f12,
    name: d.f14,
    chgPct: d.f3 != null ? d.f3 : null,
    price: d.f2,
    chgAmt: d.f169,
  }));
}

/**
 * 获取板块排行（含日涨跌，其他周期暂时显示"--"）
 */
async function fetchSectorRank() {
  const quotes = await fetchSectorQuotes(HOT_SECTOR_BKS);
  const rows = quotes.map((q, i) => ({
    '#': 0,
    代码: q.code,
    名称: q.name,
    name: q.name,
    日涨跌: q.chgPct != null ? q.chgPct.toFixed(2) : '--',
    '5日%': '--',
    '20日%': '--',
    '60日%': '--',
    '120日%': '--',
    '250日%': '--',
    chg5Days: '--',
    chg20Days: '--',
    chg60Days: '--',
    chg120Days: '--',
    chg250Days: '--',
  }));

  return rows.sort((a,b) => (parseFloat(b.日涨跌)||0) - (parseFloat(a.日涨跌)||0))
    .map((r,i) => ({ ...r, '#': i+1 }));
}

/**
 * 获取板块成份股
 */
async function fetchSectorConstituents(sectorCode, pz = 20) {
  const url = `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=${pz}&po=1&np=1&fltt=2&invt=2&fid=f3&fs=b:${sectorCode}&fields=f2,f3,f12,f14,f20,f21,f100,f102`;
  try {
    const json = await httpGetJSON(url, { headers: { 'Referer': 'https://quote.eastmoney.com/' } });
    if (!json || !json.data || !json.data.diff) return [];

    return json.data.diff.map(d => ({
      code: (d.f12 || '').startsWith('6') ? `sh${d.f12}` : `sz${d.f12}`,
      代码: d.f12 || '',
      名称: d.f14 || '',
      最新价: +(d.f2 / 100).toFixed(2),
      涨跌幅: +(d.f3 / 100).toFixed(2),
      总市值: d.f20 || d.f100 || 0,
      流通市值: d.f21 || d.f102 || 0,
    }));
  } catch (e) {
    console.error(`[SectorStocks] ${sectorCode} error:`, e.message);
    return [];
  }
}

/**
 * 获取个股简况（F10 公司概况）
 */
async function fetchStockProfile(code) {
  const normalized = normalizeCode(code);
  const numCode = codeToNumeric(normalized);
  const prefix = normalized.startsWith('sz') ? 'SZ' : 'SH';

  try {
    const raw = await httpGet(
      `https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/CompanySurveyAjax?code=${prefix}${numCode}`,
      { headers: { 'Referer': 'https://emweb.securities.eastmoney.com/' }, timeout: 10000 }
    );
    const json = JSON.parse(raw);
    if (!json || !json.jbzl) return { 代码: numCode, 名称: '--', 行业: '--' };

    const jb = json.jbzl || {};
    return {
      代码: numCode,
      名称: jb.gsmc || '--',
      行业: jb.hy || '--',
      板块: jb.bk || '--',
      上市日期: jb.ssrq || '--',
      总股本: jb.zgb || '--',
      流通股: jb.ltg || '--',
      主营业务: (jb.zyyw || '').slice(0, 200),
    };
  } catch (e) {
    console.error(`[Profile] ${code} error:`, e.message);
    return { 代码: codeToNumeric(normalized), 名称: '--', 行业: '--' };
  }
}

/**
 * 股票/基金搜索（东方财富 suggest API）
 */
async function fetchStockSearch(keyword, type = '14') {
  const url = `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(keyword)}&type=${type}&token=D43BF722C8E33BDC906FB84D85E326E8&count=10`;
  try {
    const json = await httpGetJSON(url, { headers: { 'Referer': 'https://www.eastmoney.com/' } });
    if (!json || !json.QuotationCodeTable || !json.QuotationCodeTable.Data) return [];
    return json.QuotationCodeTable.Data.map(d => ({
      code: d.Code || '',
      name: d.Name || '',
      market: d.Market || '',
      type: d.SecurityType || '',
    }));
  } catch (e) {
    console.error(`[Search] ${keyword} error:`, e.message);
    return [];
  }
}

/**
 * 基金搜索（东方财富 fundsuggest API）
 */
async function fetchFundSearch(keyword) {
  const url = `https://fundsuggest.eastmoney.com/fund/search/search?key=${encodeURIComponent(keyword)}&type=all`;
  try {
    const raw = await httpGet(url, { headers: { 'Referer': 'https://fund.eastmoney.com/' }, timeout: 8000 });
    const json = JSON.parse(raw);
    if (!json || !json.Datas) return [];
    return json.Datas.map(d => ({
      code: d.CODE || '',
      name: d.NAME || '',
      fullName: d.FullName || '',
      type: d.FTYPE || '',
      pinyin: d.PINYIN || '',
    }));
  } catch (e) {
    console.error(`[FundSearch] ${keyword} error:`, e.message);
    return [];
  }
}

/**
 * 技术指标计算（基于K线原始数据）
 */
function calculateTechnical(klines) {
  if (!klines || klines.length < 20) {
    return { 数据不足: '至少需要20根K线' };
  }

  const closes = klines.map(k => k.收盘);
  const highs = klines.map(k => k.最高);
  const lows = klines.map(k => k.最低);
  const volumes = klines.map(k => k.成交量);
  const n = closes.length;

  // MA 均线
  function ma(arr, period) {
    if (arr.length < period) return null;
    const sum = arr.slice(-period).reduce((a, b) => a + b, 0);
    return +(sum / period).toFixed(2);
  }

  // EMA
  function ema(arr, period) {
    if (arr.length < period) return null;
    const k = 2 / (period + 1);
    let emaVal = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < arr.length; i++) {
      emaVal = arr[i] * k + emaVal * (1 - k);
    }
    return +emaVal.toFixed(2);
  }

  // MACD
  function calcMACD() {
    if (closes.length < 26) return { DIF: null, DEA: null, MACD: null };
    const ema12Arr = [];
    const ema26Arr = [];
    for (let i = 11; i < n; i++) {
      const slice = closes.slice(0, i + 1);
      ema12Arr.push(ema(slice, 12));
      ema26Arr.push(ema(slice, 26));
    }
    const dif = ema12Arr[ema12Arr.length - 1] - ema26Arr[ema26Arr.length - 1];
    const difs = ema12Arr.map((e12, i) => e12 - ema26Arr[i]);
    const dea = ema(difs.slice(-9), 9);
    const bar = 2 * (dif - dea);
    return {
      DIF: +(dif || 0).toFixed(3),
      DEA: +(dea || 0).toFixed(3),
      MACD: +(bar || 0).toFixed(3),
    };
  }

  // RSI
  function calcRSI(period = 14) {
    if (closes.length < period + 1) return null;
    let gainSum = 0, lossSum = 0;
    for (let i = n - period; i < n; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff > 0) gainSum += diff;
      else lossSum += Math.abs(diff);
    }
    if (lossSum === 0) return 100;
    const rs = gainSum / lossSum;
    return +(100 - 100 / (1 + rs)).toFixed(2);
  }

  // KDJ
  function calcKDJ() {
    if (n < 9) return { K: null, D: null, J: null };
    const hh = Math.max(...highs.slice(-9));
    const ll = Math.min(...lows.slice(-9));
    const rsv = ((closes[n - 1] - ll) / (hh - ll || 1)) * 100;
    // 简化：直接用RSV估算
    return {
      K: +rsv.toFixed(2),
      D: +rsv.toFixed(2),
      J: +(3 * rsv).toFixed(2),
    };
  }

  // 布林带
  function calcBOLL() {
    if (n < 20) return { UPPER: null, MID: null, LOWER: null };
    const midLine = ma(closes, 20);
    const slice = closes.slice(-20);
    const avg = slice.reduce((a, b) => a + b, 0) / 20;
    const variance = slice.reduce((a, b) => a + (b - avg) ** 2, 0) / 20;
    const std = Math.sqrt(variance);
    return {
      UPPER: +(midLine + 2 * std).toFixed(2),
      MID: +midLine.toFixed(2),
      LOWER: +(midLine - 2 * std).toFixed(2),
    };
  }

  const latest = closes[n - 1] || 0;

  return {
    MA5: ma(closes, 5),
    MA10: ma(closes, 10),
    MA20: ma(closes, 20),
    MA60: ma(closes, 60),
    ...calcMACD(),
    RSI6: calcRSI(6),
    RSI14: calcRSI(14),
    ...calcKDJ(),
    ...calcBOLL(),
    成交量均量: ma(volumes, 5),
    最新价: latest,
  };
}

// ==================== 场外基金 API 引擎 ====================

function normalizeFundCode(code) {
  const c = code.toLowerCase().trim();
  if (c.startsWith('jj')) return c;
  if (/^\d{6}$/.test(c)) return `jj${c}`;
  return c;
}

async function fetchFundRealtime(code) {
  const fundCode = normalizeFundCode(code).replace(/^jj/, '');
  try {
    const raw = await httpGet(`https://fundgz.1234567.com.cn/js/${fundCode}.js`, {
      headers: { 'Referer': 'https://fund.eastmoney.com/' }, timeout: 8000
    });
    const match = raw.match(/jsonpgz\((\{.*\})\)/);
    if (!match) throw new Error('解析失败');
    const data = JSON.parse(match[1]);
    return {
      code: data.fundcode, name: data.name, navDate: data.jzrq,
      nav: parseFloat(data.dwjz), estimatedNav: parseFloat(data.gsz),
      estimatedChange: parseFloat(data.gszzl), updateTime: data.gztime,
    };
  } catch (e) {
    console.error(`[FundRT] ${fundCode}:`, e.message);
    return null;
  }
}

async function fetchFundDetail(code) {
  const fundCode = normalizeFundCode(code).replace(/^jj/, '');
  try {
    const raw = await httpGet(`http://fund.eastmoney.com/pingzhongdata/${fundCode}.js`, { timeout: 10000 });
    const info = {};
    const nameMatch = raw.match(/var\s+fS_name\s*=\s*"([^"]+)"/);
    if (nameMatch) info.name = nameMatch[1];
    const codeMatch = raw.match(/var\s+fS_code\s*=\s*"([^"]+)"/);
    if (codeMatch) info.code = codeMatch[1];
    info.ret1M = parseFloat((raw.match(/var\s+syl_1y\s*=\s*"([^"]+)"/) || [])[1]) || null;
    info.ret3M = parseFloat((raw.match(/var\s+syl_3y\s*=\s*"([^"]+)"/) || [])[1]) || null;
    info.ret6M = parseFloat((raw.match(/var\s+syl_6y\s*=\s*"([^"]+)"/) || [])[1]) || null;
    info.ret1Y = parseFloat((raw.match(/var\s+syl_1n\s*=\s*"([^"]+)"/) || [])[1]) || null;
    info.sourceRate = (raw.match(/var\s+fund_sourceRate\s*=\s*"([^"]+)"/) || [])[1] || '';
    info.rate = (raw.match(/var\s+fund_Rate\s*=\s*"([^"]+)"/) || [])[1] || '';
    const navMatch = raw.match(/var\s+Data_netWorthTrend\s*=\s*(\[[\s\S]*?\]);/);
    if (navMatch) {
      try {
        info.navHistory = JSON.parse(navMatch[1]).map(p => ({
          date: new Date(p.x).toISOString().slice(0, 10),
          nav: p.y, change: p.equityReturn || 0,
        }));
      } catch (e) { info.navHistory = []; }
    } else { info.navHistory = []; }
    const stocksMatch = raw.match(/var\s+stockCodesNew\s*=\s*(\[[\s\S]*?\]);/);
    info.holdingStockCodes = [];
    if (stocksMatch) {
      try { info.holdingStockCodes = JSON.parse(stocksMatch[1]); } catch (e) { /* ignore */ }
    }
    const posMatch = raw.match(/var\s+Data_fundSharesPositions\s*=\s*(\[[\s\S]*?\]);/);
    info.positionHistory = [];
    if (posMatch) {
      try {
        info.positionHistory = JSON.parse(posMatch[1]).map(p => ({
          date: new Date(p[0]).toISOString().slice(0, 10), position: p[1],
        }));
      } catch (e) { /* ignore */ }
    }
    return info;
  } catch (e) {
    console.error(`[FundDetail] ${fundCode}:`, e.message);
    return null;
  }
}

async function fetchFundNavHistory(code, pageSize = 60) {
  const fundCode = normalizeFundCode(code).replace(/^jj/, '');
  try {
    const raw = await httpGet(
      `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${fundCode}&pageIndex=1&pageSize=${pageSize}`,
      { headers: { 'Referer': 'https://fundf10.eastmoney.com/' } }
    );
    const json = JSON.parse(raw);
    if (!json.Data || !json.Data.LSJZList) return [];
    return json.Data.LSJZList.map(r => ({
      date: r.FSRQ, nav: parseFloat(r.DWJZ),
      accNav: parseFloat(r.LJJZ), change: parseFloat(r.JZZZL) || 0,
    })).reverse();
  } catch (e) {
    console.error(`[FundNav] ${fundCode}:`, e.message);
    return [];
  }
}

async function fetchFundHoldings(code) {
  const fundCode = normalizeFundCode(code).replace(/^jj/, '');
  try {
    const raw = await httpGet(
      `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=${fundCode}&topline=10&year=&month=`,
      { headers: { 'Referer': 'https://fundf10.eastmoney.com/' } }
    );
    const holdings = [];
    const rowRegex = /<tr>((?:(?!<th>)[\s\S])*?)<\/tr>/g;
    let rowMatch;
    while ((rowMatch = rowRegex.exec(raw)) !== null) {
      const rowHtml = rowMatch[1];
      const tds = [];
      const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
      let tdMatch;
      while ((tdMatch = tdRegex.exec(rowHtml)) !== null) {
        tds.push(tdMatch[1].replace(/<[^>]+>/g, '').trim());
      }
      if (tds.length >= 8 && /^\d+$/.test(tds[0]) && tds[1]) {
        holdings.push({
          rank: parseInt(tds[0]), stockCode: tds[1].trim(), stockName: tds[2].trim(),
          ratio: parseFloat(tds[6].replace('%', '')) || 0,
          shares: tds[7].trim(), marketValue: tds[8] ? tds[8].trim() : '',
        });
      }
    }
    return holdings;
  } catch (e) {
    console.error(`[FundHoldings] ${fundCode}:`, e.message);
    return [];
  }
}

/**
 * 全量基金排行（缓存5分钟）
 */
let _fundRankCache = { data: null, ts: 0 };
const FUND_RANK_TTL = 5 * 60 * 1000;

async function getFundRankAll() {
  const now = Date.now();
  if (_fundRankCache.data && (now - _fundRankCache.ts) < FUND_RANK_TTL) {
    return _fundRankCache.data;
  }
  const url = `http://fund.eastmoney.com/data/rankhandler.aspx?op=ph&dt=kf&ft=all&sc=1rzf&st=desc&pi=1&pn=20000&dx=1&v=${Math.random()}`;
  const raw = await httpGet(url, { timeout: 15000 });
  const m = raw.match(/var rankData\s*=\s*([\s\S]*?)\s*;\s*$/);
  if (!m) throw new Error('排行API解析失败');
  const data = new Function('return ' + m[1])();
  if (!data || !data.datas) throw new Error('排行API无数据');
  _fundRankCache = { data, ts: now };
  console.log(`[fundRank] 缓存刷新, 共 ${data.datas.length} 只基金`);
  return data;
}

function _normScore(value, maxRef) {
  return Math.max(0, Math.min(100, (value / maxRef) * 100));
}

async function detectCodeType(code) {
  const c = code.toLowerCase().trim();
  if (c.startsWith('jj')) return { type: 'fund', code: c };
  if (/^(sh|sz|bj)/.test(c)) {
    if (/^(sh5[0-9]|sz159|sz16)/.test(c)) return { type: 'etf', code: c };
    return { type: 'stock', code: c };
  }
  if (/^\d{6}$/.test(c)) {
    if (/^5[0-9]|^159|^16/.test(c)) return { type: 'etf', code: c.startsWith('5') ? `sh${c}` : `sz${c}` };
    if (/^6[08]/.test(c)) return { type: 'stock', code: `sh${c}` };
    if (/^[03]0/.test(c)) return { type: 'stock', code: `sz${c}` };
    return { type: 'fund', code: `jj${c}` };
  }
  return { type: 'unknown', code: c };
}

// ==================== ETF 流量映射 ====================

const MONITOR_ETFS = [
  { code: '512480', name: '半导体ETF', market: 1, sector: '半导体' },
  { code: '513100', name: '纳指ETF',   market: 1, sector: 'QDII/科技' },
  { code: '159995', name: '芯片ETF',   market: 0, sector: '半导体' },
  { code: '513050', name: '中概互联',  market: 1, sector: 'QDII/科技' },
];

const SECTOR_ETF_MAP = [
  { kw: '半导体', etfs: [{ code: '512480', name: '半导体ETF', market: 1 }] },
  { kw: '芯片',   etfs: [{ code: '159995', name: '芯片ETF', market: 0 }] },
  { kw: '人工智能', etfs: [{ code: '159819', name: 'AI智能ETF', market: 0 }] },
  { kw: '机器人',  etfs: [{ code: '562500', name: '机器人ETF', market: 1 }] },
  { kw: '新能源',  etfs: [{ code: '516160', name: '新能源ETF', market: 1 }] },
  { kw: '军工',   etfs: [{ code: '512660', name: '军工ETF', market: 1 }] },
  { kw: '医药',   etfs: [{ code: '512010', name: '医药ETF', market: 1 }] },
  { kw: '消费',   etfs: [{ code: '159928', name: '消费ETF', market: 0 }] },
  { kw: '银行',   etfs: [{ code: '512800', name: '银行ETF', market: 1 }] },
  { kw: '券商',   etfs: [{ code: '512880', name: '证券ETF', market: 1 }] },
  { kw: '通信',   etfs: [{ code: '515880', name: '通信ETF', market: 1 }] },
  { kw: '有色',   etfs: [{ code: '512400', name: '有色ETF', market: 1 }] },
  { kw: '汽车',   etfs: [{ code: '516110', name: '汽车ETF', market: 1 }] },
  { kw: '煤炭',   etfs: [{ code: '515220', name: '煤炭ETF', market: 1 }] },
  { kw: '电力',   etfs: [{ code: '159611', name: '电力ETF', market: 0 }] },
  { kw: '游戏',   etfs: [{ code: '159869', name: '游戏ETF', market: 0 }] },
  { kw: '传媒',   etfs: [{ code: '159805', name: '传媒ETF', market: 0 }] },
  { kw: '计算机', etfs: [{ code: '159998', name: '计算机ETF', market: 0 }] },
  { kw: '基建',   etfs: [{ code: '516950', name: '基建ETF', market: 1 }] },
  { kw: '光伏',   etfs: [{ code: '159857', name: '光伏ETF', market: 0 }] },
  { kw: '化工',   etfs: [{ code: '159870', name: '化工ETF', market: 0 }] },
  { kw: '钢铁',   etfs: [{ code: '515210', name: '钢铁ETF', market: 1 }] },
  { kw: '农业',   etfs: [{ code: '159825', name: '农业ETF', market: 0 }] },
  { kw: '房地产', etfs: [{ code: '512200', name: '房地产ETF', market: 1 }] },
  { kw: '旅游',   etfs: [{ code: '159766', name: '旅游ETF', market: 0 }] },
  { kw: '白酒',   etfs: [{ code: '512690', name: '酒ETF', market: 1 }] },
  { kw: '软件',   etfs: [{ code: '159852', name: '软件ETF', market: 0 }] },
  { kw: '纳指',   etfs: [{ code: '513100', name: '纳指ETF', market: 1 }] },
  { kw: '中概',   etfs: [{ code: '513050', name: '中概互联ETF', market: 1 }] },
  { kw: '标普',   etfs: [{ code: '513500', name: '标普ETF', market: 1 }] },
];

function findETFBySector(sectorName) {
  const clean = sectorName.replace(/(板块|行业|概念|指数|主题|ETF)\s*$/g, '').trim().toLowerCase();
  for (const entry of SECTOR_ETF_MAP) {
    if (clean.includes(entry.kw.toLowerCase()) || entry.kw.toLowerCase().includes(clean)) {
      return entry.etfs;
    }
  }
  return null;
}

async function fetchETFKline(secid, days = 5) {
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=0&end=20500101&lmt=${days}`;
  const raw = await httpGet(url, { timeout: 10000 });
  const json = JSON.parse(raw);
  if (!json || !json.data || !json.data.klines) return null;
  const name = json.data.name || '--';
  const preClose = json.data.preKPrice || 0;
  const days_data = json.data.klines.map(line => {
    const p = line.split(',');
    const close = parseFloat(p[2]) || 0;
    const volume = parseInt(p[5]) || 0;
    const amount = parseFloat(p[6]) || 0;
    const chgPct = parseFloat(p[8]) || 0;
    const flowScore = Math.round(chgPct * amount / 1e8 * 100) / 100;
    return {
      date: p[0], open: parseFloat(p[1]) || 0, close, high: parseFloat(p[3]) || 0,
      low: parseFloat(p[4]) || 0, volume, amount: +(amount / 1e8).toFixed(2),
      chgPct, turnover: parseFloat(p[10]) || 0, flowScore,
    };
  });
  return { name, preClose, days: days_data };
}

// ==================== API 路由 ====================

// --- 健康检查 ---
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// --- 1. ETF 详情（HTTP版）---
app.get('/api/fund/etf/:code', async (req, res) => {
  try {
    const code = normalizeCode(req.params.code);
    const quotes = await fetchStockQuote(code);
    if (!quotes.length) return res.status(404).json(fail('未找到该ETF', 404));

    const q = quotes[0];
    const result = {
      info: {
        代码: q.代码, 名称: q.名称, 最新价: q.最新价,
        '涨幅%': q['涨幅%'], 涨跌额: q.涨跌额,
        开盘: q.开盘, 最高: q.最高, 最低: q.最低, 昨收: q.昨收,
        成交量: q.成交量, 成交额: q.成交额,
        '换手率%': q['换手率%'], 总市值: q.总市值, 市盈率: q.市盈率,
      },
      manager: { 基金管理人: '通过东方财富数据获取' },
      holdings: [],
    };
    res.json(ok(result));
  } catch (e) {
    console.error('[API] etf error:', e.message);
    res.status(500).json(fail(e.message));
  }
});

// --- 2. ETF 持仓 ---
app.get('/api/fund/holdings/:code', async (req, res) => {
  try {
    const code = normalizeCode(req.params.code);
    const numCode = codeToNumeric(code);
    const holdings = await fetchFundHoldings(numCode);
    res.json(ok(holdings));
  } catch (e) {
    console.error('[API] holdings error:', e.message);
    res.status(500).json(fail(e.message));
  }
});

// --- 3. ETF 净值走势（K线数据）---
app.get('/api/fund/nav/:code', async (req, res) => {
  try {
    const code = normalizeCode(req.params.code);
    const { limit = 120 } = req.query;
    const kline = await fetchStockKline(code, 'day', parseInt(limit) || 120);
    const rows = kline.klines.map(k => ({
      日期: k.日期, 净值: k.收盘, 涨幅: k['涨跌幅%'],
      最高: k.最高, 最低: k.最低, 成交量: k.成交量,
    }));
    res.json(ok(rows));
  } catch (e) {
    console.error('[API] nav error:', e.message);
    res.status(500).json(fail(e.message));
  }
});

// --- 4. 个股行情 ---
app.get('/api/stock/quote/:codes', async (req, res) => {
  try {
    const codes = req.params.codes.split(',').map(normalizeCode).join(',');
    const rows = await fetchStockQuote(codes);
    res.json(ok(rows));
  } catch (e) {
    console.error('[API] quote error:', e.message);
    res.status(500).json(fail(e.message));
  }
});

// --- 5. K线数据 ---
app.get('/api/stock/kline/:code', async (req, res) => {
  try {
    const code = normalizeCode(req.params.code);
    const { period = 'day', limit = 120 } = req.query;
    const kline = await fetchStockKline(code, period, parseInt(limit) || 120);
    res.json(ok(kline.klines));
  } catch (e) {
    console.error('[API] kline error:', e.message);
    res.status(500).json(fail(e.message));
  }
});

// --- 6. 个股简况 ---
app.get('/api/stock/profile/:code', async (req, res) => {
  try {
    const code = normalizeCode(req.params.code);
    const profile = await fetchStockProfile(code);
    res.json(ok(profile));
  } catch (e) {
    console.error('[API] profile error:', e.message);
    res.status(500).json(fail(e.message));
  }
});

// --- 7. 财务数据（简化版）---
app.get('/api/stock/finance/:code', async (req, res) => {
  res.json(ok([], { message: '云端简化版 - 财务数据暂不支持，请使用东方财富F10查看' }));
});

// --- 8. 技术指标（基于K线计算）---
app.get('/api/stock/technical/:code', async (req, res) => {
  try {
    const code = normalizeCode(req.params.code);
    const kline = await fetchStockKline(code, 'day', 120);
    const tech = calculateTechnical(kline.klines);
    res.json(ok([tech]));
  } catch (e) {
    console.error('[API] technical error:', e.message);
    res.status(500).json(fail(e.message));
  }
});

// --- 9. 主力资金（简化版）---
app.get('/api/stock/fund/:code', (req, res) => {
  res.json(ok([], { message: '云端简化版 - 资金流向暂不支持' }));
});

// --- 10. 机构评级 ---
app.get('/api/stock/rating/:code', (req, res) => {
  res.json(ok([], { message: '云端简化版 - 机构评级暂不支持' }));
});

// --- 11. 一致预期 ---
app.get('/api/stock/consensus/:code', (req, res) => {
  res.json(ok([], { message: '云端简化版 - 一致预期暂不支持' }));
});

// --- 12. 风险事件 ---
app.get('/api/stock/risk/:code', (req, res) => {
  res.json(ok([], { message: '云端简化版 - 风险事件暂不支持' }));
});

// --- 13. 板块排行 ---
app.get('/api/sector/rank', async (req, res) => {
  try {
    const { sort } = req.query;
    let rows = await fetchSectorRank(40);

    // 支持排序
    if (sort) {
      const sortMap = { chg5Days: '5日%', chg20Days: '20日%', chg60Days: '60日%', chg120Days: '120日%', chg250Days: '250日%' };
      const field = sortMap[sort] || '涨跌幅';
      rows.sort((a, b) => (parseFloat(b[field]) || 0) - (parseFloat(a[field]) || 0));
      rows.forEach((r, i) => { r['#'] = i + 1; });
    }

    res.json(ok(rows));
  } catch (e) {
    console.error('[API] sector rank error:', e.message);
    res.status(500).json(fail(e.message));
  }
});

// --- 14a. 板块排行（含日涨跌）---
let _rankDailyCache = { data: null, ts: 0 };
const RANK_DAILY_TTL = 3 * 60 * 1000;

app.get('/api/sector/rank-with-daily', async (req, res) => {
  try {
    const now = Date.now();
    if (_rankDailyCache.data && (now - _rankDailyCache.ts) < RANK_DAILY_TTL) {
      return res.json(ok(_rankDailyCache.data));
    }

    const rows = await fetchSectorRank();
    _rankDailyCache = { data: rows, ts: now };
    res.json(ok(rows));
  } catch (e) {
    console.error('[API] rank-with-daily error:', e.message);
    res.status(500).json(fail(e.message));
  }
});

// --- 14. 板块深度分析 ---
app.get('/api/sector/analyze/:code', async (req, res) => {
  try {
    const { code } = req.params;
    // 板块K线使用90.前缀secid
    const klineUrl = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=90.${code}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=0&end=20500101&lmt=120`;
    const [klineJson, stocks] = await Promise.all([
      httpGetJSON(klineUrl, { headers: { 'Referer': 'https://quote.eastmoney.com/' } }).catch(() => null),
      fetchSectorConstituents(code, 20),
    ]);

    const klines = (klineJson && klineJson.data && klineJson.data.klines || []).map(line => {
      const p = line.split(',');
      return {
        日期: p[0], 开盘: +p[1] || 0, 收盘: +p[2] || 0,
        最高: +p[3] || 0, 最低: +p[4] || 0,
        成交量: +p[5] || 0, 成交额: +p[6] || 0,
        '涨跌幅%': +p[8] || 0,
      };
    });

    // 取前20只成份股获取行情
    const top20 = stocks.slice(0, 20);
    let quotes = [];
    if (top20.length > 0) {
      const stockCodes = top20.map(s => s.code).filter(Boolean).join(',');
      if (stockCodes) {
        try {
          quotes = await fetchStockQuote(stockCodes);
        } catch (e) { /* ignore */ }
      }
    }

    quotes.sort((a, b) => {
      const ca = parseFloat(a['涨幅%']) || 0;
      const cb = parseFloat(b['涨幅%']) || 0;
      return cb - ca;
    });

    res.json(ok({ kline: klines, stocks: top20, quotes }));
  } catch (e) {
    console.error('[API] sector analyze error:', e.message);
    res.status(500).json(fail(e.message));
  }
});

// --- 15. 板块成份股 ---
app.get('/api/sector/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const stocks = await fetchSectorConstituents(code, 50);
    res.json(ok(stocks));
  } catch (e) {
    console.error('[API] sector error:', e.message);
    res.status(500).json(fail(e.message));
  }
});

// --- 15. 板块搜索 ---
app.get('/api/sector/search/:keyword', async (req, res) => {
  try {
    const { keyword } = req.params;
    // 使用股票搜索获取相关板块
    const results = await fetchStockSearch(keyword, '14');
    // 过滤板块类型
    const sectors = results.filter(r => r.type === 'BK' || r.type === 'GN');
    res.json(ok(sectors));
  } catch (e) {
    console.error('[API] sector search error:', e.message);
    res.status(500).json(fail(e.message));
  }
});

// --- 16. 基金搜索 ---
app.get('/api/fund/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json(fail('缺少搜索关键词', 400));
    const results = await fetchFundSearch(q);
    res.json(ok(results));
  } catch (e) {
    console.error('[API] search error:', e.message);
    res.status(500).json(fail(e.message));
  }
});

// --- 17. 热门板块 ---
app.get('/api/hot/sectors', async (req, res) => {
  try {
    const { limit = 10 } = req.query;
    const rows = await fetchSectorRank(parseInt(limit) || 10);
    res.json(ok(rows));
  } catch (e) {
    console.error('[API] hot sectors error:', e.message);
    res.status(500).json(fail(e.message));
  }
});

// --- 18. 热门ETF ---
app.get('/api/hot/etf', async (req, res) => {
  try {
    const codes = 'sh510300,sh510500,sh588000,sz159915,sh513100';
    const rows = await fetchStockQuote(codes);
    res.json(ok(rows));
  } catch (e) {
    console.error('[API] hot etf error:', e.message);
    res.status(500).json(fail(e.message));
  }
});

// --- 19. 代码类型检测 ---
app.get('/api/fund/detect/:code', async (req, res) => {
  try {
    const result = await detectCodeType(req.params.code);
    res.json(ok(result));
  } catch (e) {
    res.status(500).json(fail(e.message));
  }
});

// --- 20. 场外基金实时估值 ---
app.get('/api/fund/regular/realtime/:code', async (req, res) => {
  try {
    const data = await fetchFundRealtime(req.params.code);
    if (!data) return res.status(404).json(fail('未找到该基金', 404));
    res.json(ok(data));
  } catch (e) {
    res.status(500).json(fail(e.message));
  }
});

// --- 21. 场外基金详情 ---
app.get('/api/fund/regular/detail/:code', async (req, res) => {
  try {
    const data = await fetchFundDetail(req.params.code);
    if (!data || !data.name) return res.status(404).json(fail('未找到该基金', 404));
    res.json(ok(data));
  } catch (e) {
    res.status(500).json(fail(e.message));
  }
});

// --- 22. 场外基金历史净值 ---
app.get('/api/fund/regular/nav/:code', async (req, res) => {
  try {
    const { limit = 60 } = req.query;
    const data = await fetchFundNavHistory(req.params.code, parseInt(limit));
    res.json(ok(data));
  } catch (e) {
    res.status(500).json(fail(e.message));
  }
});

// --- 23. 场外基金持仓 ---
app.get('/api/fund/regular/holdings/:code', async (req, res) => {
  try {
    const data = await fetchFundHoldings(req.params.code);
    res.json(ok(data));
  } catch (e) {
    res.status(500).json(fail(e.message));
  }
});

// --- 24. 场外基金综合分析 ---
app.get('/api/fund/regular/analysis/:code', async (req, res) => {
  try {
    const fundCode = req.params.code;
    const [realtime, detail, navHistory, holdings] = await Promise.allSettled([
      fetchFundRealtime(fundCode),
      fetchFundDetail(fundCode),
      fetchFundNavHistory(fundCode, 120),
      fetchFundHoldings(fundCode),
    ]);

    const result = {
      realtime: realtime.status === 'fulfilled' ? realtime.value : null,
      detail: detail.status === 'fulfilled' ? detail.value : null,
      navHistory: navHistory.status === 'fulfilled' ? navHistory.value : [],
      holdings: holdings.status === 'fulfilled' ? holdings.value : [],
    };

    res.json(ok(result));
  } catch (e) {
    res.status(500).json(fail(e.message));
  }
});

// --- 25. 场外基金持仓股公司数据（HTTP版）---
app.get('/api/fund/regular/holdings-enriched/:code', async (req, res) => {
  try {
    const fundCode = normalizeFundCode(req.params.code).replace(/^jj/, '');
    const holdings = await fetchFundHoldings(fundCode);
    if (holdings.length === 0) return res.json(ok([]));

    const detail = await fetchFundDetail(fundCode);
    const stockMap = {};
    if (detail && detail.holdingStockCodes) {
      detail.holdingStockCodes.forEach(c => {
        const parts = c.split('.');
        if (parts.length >= 2) {
          const marketCode = parts[0];
          const code = parts.slice(1).join('.');
          let wxCode;
          if (marketCode === '0') wxCode = `sz${code}`;
          else if (marketCode === '1') wxCode = `sh${code}`;
          else wxCode = null;
          if (wxCode) stockMap[code] = wxCode;
        }
      });
    }

    const holdingsWithCodes = holdings.map(h => ({
      ...h,
      wxCode: stockMap[h.stockCode] || stockMap[h.stockCode.toUpperCase()] || '',
    }));

    const aShareCodes = [];
    const enriched = holdingsWithCodes.map(h => {
      if (h.wxCode && /^(sh|sz)/.test(h.wxCode)) aShareCodes.push(h.wxCode);
      return h;
    });

    let quoteData = [];
    let profileData = [];

    if (aShareCodes.length > 0) {
      try {
        quoteData = await fetchStockQuote(aShareCodes.join(','));
      } catch (e) { console.warn('A股行情获取失败:', e.message); }

      for (const c of aShareCodes) {
        try {
          const profile = await fetchStockProfile(c);
          if (profile && profile.名称 !== '--') profileData.push({ code: c, ...profile });
        } catch (e) { /* skip */ }
      }
    }

    const quoteMap = {};
    quoteData.forEach(q => { if (q.code) quoteMap[q.code] = q; });
    const profileMap = {};
    profileData.forEach(p => { if (p.code) profileMap[p.code] = p; });

    const result = enriched.map(h => ({
      ...h,
      _quote: quoteMap[h.wxCode] || {},
      _profile: profileMap[h.wxCode] || {},
    }));

    res.json(ok(result));
  } catch (e) {
    console.error('[API] holdings-enriched error:', e.message);
    res.status(500).json(fail(e.message));
  }
});

// --- 26. 潜力基金筛选 ---
app.get('/api/fund/screener', async (req, res) => {
  try {
    const { sector, minChg = '0', sortBy = 'dayChange', limit = 20 } = req.query;
    const rankData = await getFundRankAll();

    let funds = rankData.datas.map(s => {
      const f = s.split(',');
      return {
        code: f[0] || '', name: f[1] || '',
        nav: parseFloat(f[4]) || 0, dayChange: parseFloat(f[6]) || 0,
        weekChange: parseFloat(f[7]) || 0, month1Change: parseFloat(f[8]) || 0,
        month3Change: parseFloat(f[9]) || 0, month6Change: parseFloat(f[10]) || 0,
        year1Change: parseFloat(f[11]) || 0,
      };
    }).filter(f => f.code && f.name);

    if (sector) {
      const cleanSector = sector.replace(/(板块|行业|概念|指数|主题)\s*$/, '').trim();
      const keywords = [sector];
      if (cleanSector !== sector) keywords.push(cleanSector);
      funds = funds.filter(f => keywords.some(kw => f.name.includes(kw)));
    }

    const minChgNum = parseFloat(minChg) || 0;
    if (minChgNum > 0) {
      const chgField = sortBy === 'weekChange' ? 'weekChange' : sortBy === 'month1Change' ? 'month1Change' : 'dayChange';
      funds = funds.filter(f => f[chgField] >= minChgNum);
    }

    funds = funds.map(f => {
      const dayS = _normScore(f.dayChange, 5);
      const weekS = _normScore(f.weekChange, 10);
      const monthS = _normScore(f.month1Change, 20);
      const momentumScore = Math.round(Math.min(55, dayS * 0.22 + weekS * 0.18 + monthS * 0.15));

      const consistencyScore = (f.dayChange > 0 && f.weekChange > 0 && f.month1Change > 0) ? 20
        : (f.dayChange > 0 && f.weekChange > 0) ? 14
        : (f.dayChange > 0) ? 8 : 3;

      const accelerationScore = (f.weekChange > f.dayChange && f.dayChange > 0) ? 15
        : (f.month1Change > f.weekChange && f.weekChange > 0) ? 10
        : (f.dayChange > 2) ? 7 : 2;

      const trendScore = f.year1Change > 30 ? 10 : f.year1Change > 10 ? 7 : f.year1Change > 0 ? 4 : 1;

      const potentialScore = Math.min(100, momentumScore + consistencyScore + accelerationScore + trendScore);

      const signals = [];
      if (f.dayChange > 1.5) signals.push('momentum');
      if (f.weekChange > 3) signals.push('fund-flow');
      if (f.weekChange > f.dayChange && f.dayChange > 0) signals.push('tech');
      if (f.month1Change > 5 && f.dayChange > 0) signals.push('breakout');

      return { ...f, potentialScore, signals };
    });

    funds.sort((a, b) => b.potentialScore - a.potentialScore);
    const result = funds.slice(0, Math.min(parseInt(limit) || 20, 50));
    res.json(ok({ funds: result, total: funds.length }));
  } catch (e) {
    console.error('[API] screener error:', e.message);
    res.status(500).json(fail(e.message));
  }
});

// --- 27. 板块相关场外基金 ---
app.get('/api/fund/regular/sector-top/:sectorName', async (req, res) => {
  try {
    const sectorName = decodeURIComponent(req.params.sectorName);
    const topN = parseInt(req.query.top) || 10;
    const rankData = await getFundRankAll();
    const cleanName = sectorName.replace(/(板块|行业|概念|指数|主题)\s*$/, '').trim();
    const keywords = [sectorName];
    if (cleanName !== sectorName) keywords.push(cleanName);

    const matched = rankData.datas.filter(s => {
      const f = s.split(',');
      const name = f[1] || '';
      return keywords.some(kw => name.includes(kw));
    });

    if (matched.length === 0) return res.json(ok({ rise: [], fall: [], total: 0 }));

    const funds = matched.map(s => {
      const f = s.split(',');
      return {
        code: f[0] || '', name: f[1] || '',
        nav: parseFloat(f[4]) || 0, dayChange: parseFloat(f[6]) || 0,
        weekChange: parseFloat(f[7]) || 0, month1Change: parseFloat(f[8]) || 0,
        month3Change: parseFloat(f[9]) || 0, month6Change: parseFloat(f[10]) || 0,
        year1Change: parseFloat(f[11]) || 0,
      };
    }).filter(f => f.code && f.name);

    funds.sort((a, b) => b.dayChange - a.dayChange);
    const rise = funds.slice(0, topN);
    const fall = funds.length > topN ? funds.slice(-Math.min(topN, funds.length)).reverse() : [];

    res.json(ok({ rise, fall, total: funds.length }));
  } catch (e) {
    console.error('[API] sector-top error:', e.message);
    res.status(500).json(fail(e.message));
  }
});

// ==================== ETF 资金流向（纯HTTP）====================

app.get('/api/etf/flow', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 5;
    let etfList;
    if (req.query.codes) {
      const codeArr = req.query.codes.split(',').map(c => c.trim()).filter(Boolean);
      etfList = codeArr.map(c => ({ code: c, name: '', market: c.startsWith('5') ? 1 : 0 }));
    } else {
      etfList = MONITOR_ETFS;
    }

    const results = await Promise.all(
      etfList.map(async etf => {
        const secid = `${etf.market}.${etf.code}`;
        try {
          const data = await fetchETFKline(secid, days);
          return { code: etf.code, sector: etf.sector || '', ...data };
        } catch (e) {
          return { code: etf.code, sector: etf.sector || '', error: e.message };
        }
      })
    );

    res.json(ok({ etfs: results, updated: new Date().toISOString() }));
  } catch (e) {
    console.error('[API] etf/flow error:', e.message);
    res.status(500).json(fail(e.message));
  }
});

app.get('/api/etf/flow/sector', async (req, res) => {
  try {
    const sectorNames = (req.query.sectors || '').split(',').map(s => s.trim()).filter(Boolean);
    const days = parseInt(req.query.days) || 5;

    const etfTasks = sectorNames.map(name => {
      const etfs = findETFBySector(name);
      if (!etfs) return [];
      return etfs.map(e => ({ ...e, sector: name }));
    }).flat();

    if (!etfTasks.length) return res.json(ok({ etfs: [], updated: new Date().toISOString() }));

    const seen = new Set();
    const unique = etfTasks.filter(e => {
      const key = e.code;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const results = await Promise.all(
      unique.map(async etf => {
        const secid = `${etf.market}.${etf.code}`;
        try {
          const data = await fetchETFKline(secid, days);
          return { code: etf.code, sector: etf.sector, ...data };
        } catch (e) {
          return { code: etf.code, sector: etf.sector, error: e.message };
        }
      })
    );

    res.json(ok({ etfs: results, updated: new Date().toISOString() }));
  } catch (e) {
    console.error('[API] etf/flow/sector error:', e.message);
    res.status(500).json(fail(e.message));
  }
});

// ==================== SPA 路由 fallback ====================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ==================== 启动 ====================
const os = require('os');

function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '0.0.0.0';
}

app.listen(PORT, '0.0.0.0', () => {
  const localIP = getLocalIP();
  console.log(`
╔══════════════════════════════════════════════╗
║   Fund Insight Pro - 基金智能分析平台       ║
║   (纯HTTP直连版 - 无CLI依赖)               ║
║                                              ║
║   Local:   http://localhost:${PORT}             ║
║   Network: http://${localIP}:${PORT}        ║
║   手机扫码或输入 Network 地址即可访问         ║
╚══════════════════════════════════════════════╝
  `);
});
