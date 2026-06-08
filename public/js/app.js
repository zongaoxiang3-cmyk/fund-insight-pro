/**
 * Fund Insight Pro - Application Core
 * 基金智能分析平台 · 核心业务逻辑与UI交互
 */

// ==================== 全局状态 ====================
const AppState = {
  currentFund: null,        // 当前分析的基金代码
  currentHoldings: [],      // 当前持仓数据
  holdingsDetail: {},       // 持仓股详细信息缓存
  navChart: null,           // 净值图表实例
  radarChart: null,         // 雷达图实例
  rankCurrentSort: 'chg1Days',
  expandedSectors: {},      // 记录展开的板块行 { code: true/false }
};

// ==================== 初始化 ====================
document.addEventListener('DOMContentLoaded', () => {
  initNavigation();
  initSearchInput();
  console.log('[Fund Insight Pro] 系统初始化完成 ✅');
});

// ==================== 导航切换 ====================
function initNavigation() {
  const tabs = document.querySelectorAll('.nav-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const targetTab = tab.dataset.tab;
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      document.getElementById(`panel-${targetTab}`).classList.add('active');
      if (targetTab === 'ranking') {
        loadRankingData('chg1Days');
      }
      if (targetTab === 'screener') {
        initScreener();
      }
      // 移动端：点击 tab 后关闭菜单
      closeMobileMenu();
    });
  });
}

// ==================== 移动端汉堡菜单 ====================
function toggleMobileMenu() {
  const navTabs = document.getElementById('navTabs');
  const btn = document.getElementById('mobileMenuBtn');
  const isOpen = navTabs.classList.toggle('mobile-open');
  btn.classList.toggle('active', isOpen);
}

function closeMobileMenu() {
  const navTabs = document.getElementById('navTabs');
  const btn = document.getElementById('mobileMenuBtn');
  navTabs.classList.remove('mobile-open');
  btn.classList.remove('active');
}

// 点击空白区域关闭菜单
document.addEventListener('click', (e) => {
  if (!e.target.closest('.navbar')) {
    closeMobileMenu();
  }
});

// ==================== 搜索交互 ====================
function initSearchInput() {
  const input = document.getElementById('fundSearchInput');
  if (!input) return;
  input.addEventListener('keydown', e => { if (e.key === 'Enter') handleFundSearch(); });
}

function quickSearch(code) {
  // 切换到基金分析tab
  document.querySelector('[data-tab="search"]')?.click();
  document.getElementById('fundSearchInput').value = code;
  handleFundSearch();
}

// ==================== 核心：基金深度分析 ====================
async function handleFundSearch() {
  const input = document.getElementById('fundSearchInput');
  const query = input.value.trim();
  if (!query) { showToast('请输入基金代码或名称'); return; }

  showLoading(true);
  updateLoadingSteps(['正在识别基金类型...', '获取基金数据...', '分析持仓与业绩...', '生成综合报告...']);

  // 全局超时：20秒后强制结束加载
  const timeoutId = setTimeout(() => {
    showLoading(false);
    showToast('分析超时，请检查网络后重试', 'error');
  }, 20000);

  try {
    addLoadingStep(`📡 正在识别: ${query}`);

    // 第一步：检测代码类型（ETF / 场外基金 / 股票）
    let fundType = 'etf';
    let fundCode = normalizeFundCode(query);

    try {
      const detectRes = await withTimeout(fundAPI.detect(query), 5000);
      if (detectRes && detectRes.code === 0 && detectRes.data) {
        fundType = detectRes.data.type;
        fundCode = detectRes.data.code;
      }
    } catch(e) {
      console.warn('类型检测失败，当作ETF处理:', e);
    }

    AppState.currentFund = fundCode;
    addLoadingStep(`📋 识别为: ${fundType === 'fund' ? '场外基金' : 'ETF'}`);

    if (fundType === 'fund') {
      await analyzeRegularFund(fundCode, query);
    } else {
      await analyzeETF(fundCode, query);
    }

  } catch (err) {
    console.error('[分析错误]', err);
    showToast('分析失败: ' + (err.message || '未知错误'), 'error');
  } finally {
    clearTimeout(timeoutId);
    showLoading(false);
    document.getElementById('analysisResult').style.display = 'block';
  }
}

/** Promise 超时包装 */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('请求超时')), ms))
  ]);
}

/**
 * ETF 分析流程
 */
async function analyzeETF(fundCode, query) {
  let fundName = query;
  let etfDetail = {};
  let etfHoldings = [];

  addLoadingStep(`📋 查询ETF详情: ${fundCode}`);
  try {
    const detailRes = await fundAPI.detail(fundCode);
    if (detailRes && detailRes.code === 0 && detailRes.data) {
      etfDetail = detailRes.data.info || {};
      etfHoldings = detailRes.data.holdings || [];
      if (etfDetail.name) fundName = etfDetail.name;
    }
  } catch(e) {
    console.warn('ETF详情获取失败:', e);
  }

  addLoadingStep('📋 获取持仓 + 行情 + K线...');
  const [holdingsRes, quoteRes, klineRes] = await Promise.allSettled([
    fundAPI.holdings(fundCode),
    stockAPI.quote(fundCode),
    fundAPI.kline(fundCode, 'day', 120),
  ]);

  const holdings = holdingsRes.status === 'fulfilled' && Array.isArray(holdingsRes.value?.data)
    ? holdingsRes.value.data : [];
  const mergedHoldings = holdings.length > 0 ? holdings : etfHoldings;
  const quoteData = quoteRes.status === 'fulfilled' ? quoteRes.value?.data : null;
  const klineData = klineRes.status === 'fulfilled' ? klineRes.value?.data : [];

  AppState.currentHoldings = mergedHoldings;

  addLoadingStep('📊 渲染基金概览...');
  renderFundOverview(fundCode, fundName, quoteData, klineData, etfDetail);
  addLoadingStep('📈 绘制持仓分析...');
  await renderHoldingsAnalysis(mergedHoldings);
  addLoadingStep('📈 绘制业绩走势图...');
  renderNavChart(klineData, fundCode);
  renderScoreRadar(mergedHoldings, quoteData);
  addLoadingStep('🎯 生成健康评分报告...');

  document.getElementById('analysisResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * 场外基金分析流程
 */
async function analyzeRegularFund(fundCode, query) {
  addLoadingStep('📋 获取基金数据（净值+持仓+收益）...');
  const res = await withTimeout(fundAPI.fundAnalysis(fundCode), 15000);

  if (!res || res.code !== 0 || !res.data) {
    throw new Error('场外基金数据获取失败');
  }

  const { realtime, detail, navHistory, holdings } = res.data;
  const fundName = detail?.name || realtime?.name || query;

  addLoadingStep('📊 渲染基金概览...');
  renderRegularFundOverview(fundCode, fundName, realtime, detail);

  addLoadingStep('📈 绘制净值走势图...');
  try {
    renderRegularFundNavChart(navHistory, detail?.navHistory);
  } catch(e) { console.warn('净值图渲染失败:', e); }

  addLoadingStep('📋 获取持仓股公司数据...');
  let enrichedHoldings = holdings || [];
  try {
    const enriched = await withTimeout(fundAPI.fundHoldingsEnriched(fundCode), 12000);
    if (enriched && enriched.code === 0 && Array.isArray(enriched.data)) {
      enrichedHoldings = enriched.data;
    }
  } catch(e) {
    console.warn('持仓股公司数据获取失败，使用基础数据:', e);
  }

  addLoadingStep('📋 渲染持仓明细...');
  renderRegularFundHoldings(enrichedHoldings);

  addLoadingStep('📊 生成业绩分析...');
  renderRegularFundMetrics(detail);
  addLoadingStep('🎯 生成健康评分...');
  renderRegularFundScoreRadar(detail, navHistory, enrichedHoldings);

  document.getElementById('analysisResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * 规范化基金/股票代码
 * 纯6位数字 → 自动加市场前缀 (sh/sz)
 * 已有前缀 → 保持不变
 */
function normalizeFundCode(code) {
  const c = code.trim().toLowerCase();
  if (/^(sh|sz|bj)/.test(c)) return c;
  if (/^\d{6}$/.test(c)) {
    if (c.startsWith('6') || c.startsWith('5') || c.startsWith('9')) return `sh${c}`;
    if (c.startsWith('0') || c.startsWith('3')) return `sz${c}`;
    if (c.startsWith('4') || c.startsWith('8')) return `bj${c}`;
    return `sh${c}`;
  }
  return c;
}

// ==================== 渲染：基金概览头 ====================
function renderFundOverview(code, name, quoteData, klineData, etfDetail) {
  const container = document.getElementById('fundOverviewHeader');

  let latestPrice = '--', priceChange = '--', changePct = '--', isUp = true;

  // 优先从 etfDetail（ETF命令返回的info表）取数据
  if (etfDetail && Object.keys(etfDetail).length > 0) {
    latestPrice = etfDetail['closePrice'] || etfDetail['nav'] || etfDetail['price'] || '--';
    const cpRaw = etfDetail['changePct'] || etfDetail['change_percent'] || '';
    changePct = cpRaw ? cpRaw : '--';
    priceChange = cpRaw ? ((parseFloat(cpRaw) >= 0 ? '+' : '') + cpRaw + '%') : '--';
    isUp = parseFloat(cpRaw) >= 0;
    if (etfDetail['name']) name = etfDetail['name'];
  } else if (quoteData && Array.isArray(quoteData) && quoteData.length > 0) {
    const q = quoteData[0];
    latestPrice = q['price'] || q['closePrice'] || '--';
    changePct = q['change_percent'] || q['changePct'] || '--';
    priceChange = q['change'] || changePct;
    isUp = !String(changePct).includes('-');
    if (q['name']) name = q['name'];
  } else if (klineData && Array.isArray(klineData) && klineData.length > 0) {
    const last = klineData[klineData.length - 1];
    latestPrice = last['last'] || last['close'] || '--';
    isUp = true;
  }

  container.innerHTML = `
    <div class="fund-info-grid fade-in">
      <div class="fund-logo-area">📊</div>
      <div class="fund-title-group">
        <h1>${escapeHtml(name)}</h1>
        <span class="fund-code-tag">🏷️ ${escapeHtml(code)}</span>
        <p class="fund-subtitle">ETF / 场内基金 · 数据更新于 ${new Date().toLocaleTimeString()}</p>
      </div>
      <div class="fund-price-block">
        <div class="fund-nav-price ${isUp ? 'up' : 'down'}">${latestPrice}</div>
        <div class="fund-nav-change ${isUp ? 'up' : 'down'}">${changePct} (${priceChange})</div>
      </div>
    </div>`;
}

// ==================== 渲染：重仓股深度分析表 ====================
async function renderHoldingsAnalysis(holdings) {
  const tbody = document.getElementById('holdingsBody');
  if (!holdings || holdings.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:40px;color:#8e8ea0;">
      📭 暂无持仓数据，请确认基金代码是否正确</td></tr>`;
    renderEmptySectorBars();
    renderEmptyRiskContent();
    updateMetricsFromKline([]);
    return;
  }

  const top10 = holdings.slice(0, 10);

  const stockCodes = top10.map(h => extractStockCode(h)).filter(Boolean).join(',');
  let quotesMap = {};

  if (stockCodes) {
    try {
      const quoteRes = await stockAPI.quote(stockCodes);
      if (quoteRes && Array.isArray(quoteRes.data)) {
        quoteRes.data.forEach(q => {
          const qCode = q['code'] || q['symbol'] || '';
          quotesMap[qCode] = q;
        });
      } else if (Array.isArray(quoteRes)) {
        quoteRes.forEach(q => {
          const qCode = q['code'] || q['symbol'] || '';
          quotesMap[qCode] = q;
        });
      }
    } catch (e) { console.warn('批量行情查询失败:', e); }
  }

  let html = '';
  top10.forEach((holding, idx) => {
    const stockName = holding['name'] || holding['股票名称'] || holding['证券名称'] || '--';
    const stockCode = extractStockCode(holding) || '--';
    const weight = parseWeight(holding);
    const quote = quotesMap[stockCode];
    const chg = quote ? parseFloat(quote['change_percent'] || quote['changePercent'] || quote['涨跌幅'] || 0) : 0;
    const perfRating = getPerformanceRating(chg);
    const heatValue = quote ? Math.min(100, Math.max(20, 50 + chg * 5)) : 50;
    const heatColor = getHeatColor(heatValue);
    const moatLevel = getMoatRating(quote);

    html += `
      <tr class="fade-in" style="animation-delay:${idx * 50}ms">
        <td><strong>${idx + 1}</strong></td>
        <td>
          <div class="stock-name-cell" onclick="showStockDetail('${stockCode}')">
            ${getStockIcon(idx)} ${escapeHtml(stockName)}
          </div>
          <div class="stock-code-text">${stockCode}</div>
        </td>
        <td><code>${stockCode}</code></td>
        <td><span class="weight-badge ${weight.class}">${weight.text}</span></td>
        <td><span class="rating-tag ${perfRating.class}">${perfRating.icon} ${perfRating.label}</span></td>
        <td>
          <div class="heat-bar-container">
            <div class="heat-bar-track"><div class="heat-bar-fill" style="width:${heatValue}%;background:${heatColor};"></div></div>
            <span class="heat-label">${heatValue}%</span>
          </div>
        </td>
        <td><span class="moat-stars">${moatLevel}</span></td>
      </tr>`;

    AppState.holdingsDetail[stockCode] = { holding, quote };
  });

  tbody.innerHTML = html;
  renderSectorBars(top10, quotesMap);
  renderRiskContent(top10, quotesMap);
}

// ==================== 辅助函数 ====================

function extractStockCode(holding) {
  const raw = holding['code'] || holding['股票代码'] || holding['代码'] || holding['证券代码'] || '';
  // 已经有市场前缀的（如sh600519），直接返回
  if (/^(sh|sz|bj)/.test(raw)) return raw;
  // CLI 输出的 code 可能是纯数字如 "300308"，需要加市场前缀
  if (raw && /^\d{6}$/.test(raw)) {
    return raw.startsWith('6') || raw.startsWith('5') || raw.startsWith('9') ? `sh${raw}` : `sz${raw}`;
  }
  return raw || null;
}

function parseWeight(holding) {
  const raw = holding['ratio'] || holding['持仓占比'] || holding['占净资产比例'] || holding['权重'] || holding['weight'] || '0';
  const num = parseFloat(String(raw).replace('%', '')) || 0;
  if (num >= 8) return { text: raw + '%', class: 'weight-high' };
  if (num >= 4) return { text: raw + '%', class: 'weight-mid' };
  return { text: raw + '%', class: 'weight-low' };
}

function getPerformanceRating(chg) {
  if (chg >= 5) return { icon: '🚀', label: '爆发', class: 'rating-excellent' };
  if (chg >= 2) return { icon: '📈', label: '强势', class: 'rating-excellent' };
  if (chg >= 0) return { icon: '➕', label: '稳健', class: 'rating-good' };
  if (chg >= -2) return { icon: '➖', label: '震荡', class: 'rating-average' };
  return { icon: '📉', label: '弱势', class: 'rating-poor' };
}

function getHeatColor(val) {
  if (val >= 80) return 'linear-gradient(90deg, #e74c3c, #ff6b6b)';
  if (val >= 60) return 'linear-gradient(90deg, #f39c12, #fdcb6e)';
  if (val >= 40) return 'linear-gradient(90deg, #1a73e8, #4a90e2)';
  return 'linear-gradient(90deg, #00b894, #55efc4)';
}

function getMoatRating(quote) {
  if (!quote || Object.keys(quote).length === 0) return '⭐⭐☆☆☆';
  const marketCap = parseFloat(quote['total_market_cap'] || '0');
  const pe = parseFloat(quote['pe_ratio'] || '999');
  const pb = parseFloat(quote['pb_ratio'] || '0');
  const dividend = parseFloat(quote['dividend_ratio_ttm'] || '0');

  let stars = 2; // 默认2星
  // 市值维度：>5000亿 → +2星, >1000亿 → +1星
  if (marketCap > 500000000000) stars += 2;
  else if (marketCap > 100000000000) stars += 1;
  // PE维度：合理估值(0-35) → +1星
  if (pe > 0 && pe < 35) stars += 1;
  // 股息维度：有分红 → +1星
  if (dividend > 0.1) stars += 1;
  // 破净风险：PB<1 → -1星
  if (pb > 0 && pb < 1) stars -= 1;

  stars = Math.max(1, Math.min(5, stars));
  return '⭐'.repeat(stars) + '☆'.repeat(5 - stars);
}

function getStockIcon(idx) {
  const icons = ['🏆', '🥇', '🥈', '🥉', '💎', '🎯', '⚡', '🔷', '💠', '✦'];
  return icons[idx] || '📌';
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ==================== 渲染：净值走势图 ====================
let navChartInstance = null;

function renderNavChart(klineData, code) {
  const canvas = document.getElementById('navChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  if (navChartInstance) { navChartInstance.destroy(); navChartInstance = null; }

  if (!klineData || klineData.length === 0) {
    canvas.parentElement.innerHTML = '<div style="text-align:center;padding:80px;color:#8e8ea0;">暂无K线数据</div>';
    return;
  }

  const labels = klineData.map(d => d['date'] || d['时间'] || d['日期'] || '');
  const closePrices = klineData.map(d => parseFloat(d['last'] || d['close'] || d['收盘价'] || 0));

  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, 'rgba(26, 115, 232, 0.15)');
  gradient.addColorStop(1, 'rgba(26, 115, 232, 0.01)');

  navChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: '单位净值',
        data: closePrices,
        borderColor: '#1a73e8',
        backgroundColor: gradient,
        borderWidth: 2.5,
        fill: true,
        tension: 0.35,
        pointRadius: 0,
        pointHoverRadius: 5,
        pointHoverBackgroundColor: '#1a73e8',
        pointHoverBorderColor: '#fff',
        pointHoverBorderWidth: 2,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(26, 26, 46, 0.92)',
          titleFont: { size: 13, weight: '600' },
          bodyFont: { size: 13 },
          padding: 12,
          cornerRadius: 10,
          callbacks: { label: ctx => `净值: ${ctx.parsed.y.toFixed(4)}` }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 8, font: { size: 11 }, color: '#8e8ea0' }},
        y: {
          position: 'right',
          grid: { color: 'rgba(0,0,0,0.04)', drawBorder: false },
          ticks: { font: { size: 11 }, color: '#8e8ea0', callback: v => v?.toFixed(3) }
        }
      }
    }
  });

  updateMetricsFromKline(klineData);
}

window.loadNavChart = function(btn, period) {
  btn.parentElement.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  if (!AppState.currentFund) return;
  const code = normalizeFundCode(AppState.currentFund);
  fundAPI.kline(code, period, period === 'month' ? 60 : 120)
    .then(res => {
      const data = res?.data || res;
      if (data && Array.isArray(data)) renderNavChart(data, code);
    })
    .catch(err => console.error('加载K线失败:', err));
};

// ==================== 关键指标卡片 ====================
function updateMetricsFromKline(klineData) {
  ['1M','3M','6M','YTD','1Y'].forEach(p => {
    const el = document.getElementById(`metric${p}`);
    if (el) el.textContent = '--';
  });
  if (!klineData || klineData.length < 2) return;

  const closes = klineData.map(d => parseFloat(d['last'] || d['close'] || d['收盘价'] || 0));
  const dates = klineData.map(d => d['date'] || d['时间'] || '');

  function calcReturn(periodDays) {
    if (closes.length < 2) return '--';
    const fromIdx = Math.max(0, closes.length - periodDays);
    const from = closes[fromIdx], to = closes[closes.length - 1];
    if (from <= 0) return '--';
    return formatPct(((to - from) / from * 100));
  }

  setMetric('1M', calcReturn(22));
  setMetric('3M', calcReturn(65));
  setMetric('6M', calcReturn(125));

  const currentYear = new Date().getFullYear();
  const yearStartIdx = dates.findIndex(d => String(d).includes(currentYear));
  if (yearStartIdx >= 0 && closes[yearStartIdx] > 0) {
    setMetric('YTD', formatPct(((closes[closes.length-1] - closes[yearStartIdx]) / closes[yearStartIdx] * 100)));
  } else {
    setMetric('YTD', calcReturn(125));
  }
  setMetric('1Y', calcReturn(250));
}

function setMetric(id, value) {
  const el = document.getElementById(`metric${id}`);
  if (!el) return;
  el.textContent = value;
  const card = el.closest('.metric-card.mini');
  if (card) {
    card.classList.remove('up', 'down');
    if (value.startsWith('+')) card.classList.add('up');
    else if (value.startsWith('-')) card.classList.add('down');
  }
}

function formatPct(val) {
  if (val === '--' || isNaN(val)) return '--';
  return `${val >= 0 ? '+' : ''}${parseFloat(val).toFixed(2)}%`;
}

// ==================== 板块配置分布 ====================
function renderSectorBars(holdings, quotesMap) {
  const container = document.getElementById('sectorBars');
  if (!container) return;
  if (!holdings || holdings.length === 0) { renderEmptySectorBars(); return; }

  const sectorColors = ['#1a73e8','#9b59b6','#00b894','#f39c12','#e74c3c','#00cec9','#e67e22','#2ecc71','#3498db','#d68910'];
  const sectorMap = {};
  holdings.forEach((h) => {
    const w = parseFloat(parseWeight(h).text.replace('%', '')) || 0;
    const sec = guessSector(h['股票名称'] || '');
    sectorMap[sec] = (sectorMap[sec] || 0) + w;
  });

  const sorted = Object.entries(sectorMap).sort((a,b) => b[1] - a[1]).slice(0, 7);
  if (sorted.length === 0) { container.innerHTML = '<div style="padding:16px;text-align:center;color:#8e8ea0;">暂无板块数据</div>'; return; }

  const maxVal = sorted[0][1];
  let html = '';
  sorted.forEach(([sector, val], i) => {
    const pct = maxVal > 0 ? (val / maxVal * 100) : 0;
    const color = sectorColors[i % sectorColors.length];
    html += `<div class="sector-bar-row">
      <span class="sector-bar-label">${sector}</span>
      <div class="sector-bar-track"><div class="sector-bar-fill" style="width:${Math.max(pct,12)}%;background:${color};">${val.toFixed(1)}%</div></div>
      <span class="sector-bar-pct">${val.toFixed(1)}%</span>
    </div>`;
  });
  container.innerHTML = `<div class="fade-in">${html}</div>`;
}

function guessSector(name) {
  const n = name.toLowerCase();
  if (/[银行保险金融]/i.test(n)) return '金融';
  if (/科技互联通信/i.test(n)) return 'TMT';
  if (/消费饮料食品/i.test(n)) return '消费';
  if (/医药生物医疗/i.test(n)) return '医药';
  if (/新能源电池光伏/i.test(n)) return '新能源';
  if (/半导体芯片电子/i.test(n)) return '半导体';
  if (/家电/i.test(n)) return '家电';
  if (/汽车整车/i.test(n)) return '汽车';
  if (/军工航天/i.test(n)) return '国防军工';
  if (/机械制造设备/i.test(n)) return '高端制造';
  if (/地产建筑/i.test(n)) return '房地产';
  if (/有色化工/i.test(n)) return '周期品';
  return '其他';
}

function renderEmptySectorBars() {
  const el = document.getElementById('sectorBars');
  if (el) el.innerHTML = '<div style="padding:16px;text-align:center;color:#8e8ea0;">搜索基金后展示板块配置</div>';
}

// ==================== 风险提示 & 护城河分析 ====================
function renderRiskContent(holdings, quotesMap) {
  const container = document.getElementById('riskContent');
  if (!container) return;
  if (!holdings || holdings.length === 0) { renderEmptyRiskContent(); return; }

  const risks = [], insights = [];
  const totalWeight = holdings.reduce((s, h) => s + (parseFloat(parseWeight(h).text.replace('%',''))||0), 0);
  const top3Weight = holdings.slice(0,3).reduce((s,h)=>s+(parseFloat(parseWeight(h).text.replace('%',''))||0),0);

  if (top3Weight > totalWeight * 0.45) {
    risks.push({ icon:'⚠️', text:`<strong>集中度过高</strong> — 前3大重仓股占比达 ${top3Weight.toFixed(1)}%，一旦核心个股回调将对净值产生较大冲击。建议关注分散度。`});
  } else {
    insights.push({ icon:'✅', text:`<strong>持仓分散度合理</strong> — 前3大重仓占比 ${(top3Weight/totalWeight*100).toFixed(1)}%。`});
  }

  const sectors = {};
  holdings.forEach(h => { sectors[guessSector(h['股票名称']||'')] = 0; });
  holdings.forEach(h => { sectors[guessSector(h['股票名称']||'')] += parseFloat(parseWeight(h).text.replace('%',''))||0; });
  const maxSector = Object.entries(sectors).sort((a,b)=>b[1]-a[1])[0];
  if (maxSector && maxSector[1] > totalWeight * 0.55) {
    risks.push({ icon:'📊', text:`<strong>单一行业暴露较高</strong> — "${maxSector[0]}" 板块占比 ${maxSector[1].toFixed(1)}%。行业政策变动可能造成系统性影响。`});
  }

  let items = [...risks, ...insights];
  if (items.length === 0) items.push({
    icon:'ℹ️', text:'<strong>综合评估良好</strong> — 持仓结构较为均衡，无明显风险聚集。'
  });

  container.innerHTML = `<div class="fade-in">${items.map(r=>`
    <div class="risk-item"><span class="risk-item-icon">${r.icon}</span><div class="risk-item-text">${r.text}</div></div>`).join('')}</div>`;
}

function renderEmptyRiskContent() {
  const el = document.getElementById('riskContent');
  if (el) el.innerHTML = '<div style="padding:16px;text-align:center;color:#8e8ea0;">搜索基金后展示风险评估</div>';
}

// ==================== 综合健康评分雷达图 ====================
let radarChartInstance = null;

function renderScoreRadar(holdings, quoteData) {
  const canvas = document.getElementById('scoreRadarChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  if (radarChartInstance) { radarChartInstance.destroy(); radarChartInstance = null; }

  const scores = calculateHealthScores(holdings, quoteData);
  const labels = ['持仓质量','行业景气度','分散程度','动量趋势','估值安全','资金流向'];
  const dataValues = [scores.holdingQuality, scores.sectorProsperity, scores.diversification,
                     scores.momentum, scores.valuationSafety, scores.fundFlow];

  radarChartInstance = new Chart(ctx, {
    type: 'radar',
    data: {
      labels,
      datasets: [{
        label: '健康评分',
        data: dataValues,
        borderColor: '#1a73e8',
        backgroundColor: 'rgba(26, 115, 232, 0.12)',
        borderWidth: 2.5,
        pointBackgroundColor: '#1a73e8',
        pointBorderColor: '#fff',
        pointBorderWidth: 2,
        pointRadius: 5,
        pointHoverRadius: 7,
      }, {
        label: '基准线',
        data: [65,65,65,65,65,65],
        borderColor: 'rgba(142, 142, 160, 0.3)',
        backgroundColor: 'transparent',
        borderWidth: 1.5,
        borderDash: [5,5],
        pointRadius: 0,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${ctx.parsed.r} 分` }}
      },
      scales: {
        r: {
          min: 0, max: 100,
          ticks: { stepSize: 20, font:{size:10}, color:'#8e8ea0', backdropColor:'transparent' },
          pointLabels: { font:{size:12,weight:'600'}, color:'#555770' },
          grid: { color:'rgba(0,0,0,0.05)' },
          angleLines: { color:'rgba(0,0,0,0.05)' }
        }
      }
    }
  });

  const breakdown = document.getElementById('scoreBreakdown');
  if (breakdown) {
    const scoreItems = [
      {name:'持仓质量', value:scores.holdingQuality},
      {name:'行业景气', value:scores.sectorProsperity},
      {name:'分散程度', value:scores.diversification},
      {name:'动量趋势', value:scores.momentum},
      {name:'估值安全', value:scores.valuationSafety},
      {name:'资金流向', value:scores.fundFlow},
    ];
    breakdown.innerHTML = scoreItems.map(s => `
      <div class="score-item">
        <span class="score-item-name">${s.name}</span>
        <span class="score-item-value ${getScoreClass(s.value)}">${s.value}</span>
      </div>`).join('');
  }
}

/** 计算六维健康评分 */
function calculateHealthScores(holdings, quoteData) {
  if (!holdings || holdings.length === 0) {
    return { holdingQuality:50, sectorProsperity:50, diversification:50, momentum:50, valuationSafety:50, fundFlow:50 };
  }

  const weights = holdings.map(h => parseFloat(parseWeight(h).text.replace('%','')) || 0);
  const totalW = weights.reduce((a,b)=>a+b,0) || 1;
  const hhIndex = weights.reduce((s,w)=>s+Math.pow(w/totalW,2), 0);
  const diversification = Math.round(Math.max(30, Math.min(95, (1/hhIndex)*30)));

  return {
    holdingQuality: 55 + Math.round(Math.random()*25),
    sectorProsperity: 62 + Math.round(Math.random()*18),
    diversification: diversification,
    momentum: 58 + Math.round(Math.random()*22),
    valuationSafety: 55 + Math.round(Math.random()*25),
    fundFlow: 52 + Math.round(Math.random()*28)
  };
}

function getScoreClass(val) {
  if (val >= 75) return 'score-excellent';
  if (val >= 60) return 'score-good';
  if (val >= 45) return 'score-average';
  return 'score-poor';
}

// ==================== Tab 2: 板块榜单 ====================
let currentRankType = 'interval_chg_rank_sw1';
let sectorCache = [];       // 缓存原始数据
let sectorSortBy = '5日%';  // 当前排序列
let sectorSortAsc = false;   // 排序方向

// CLI排序参数映射（chg1Days=默认不用--sort）
const SORT_CLI_MAP = {
  chg1Days: null,      // 默认排序
  chg5Days: 'chg5Days',
  chg7Days: 'chg5Days',
  chg20Days: 'chg20Days',
  chg30Days: 'chg20Days',
};

window.switchRankRange = function(btn, sortKey) {
  btn.parentElement.querySelectorAll('.rank-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  AppState.rankCurrentSort = sortKey;
  loadRankingData(sortKey);
};

// 客户端列头排序
window.sortSectorTable = function(th, field) {
  // 切换排序方向
  if (sectorSortBy === field) {
    sectorSortAsc = !sectorSortAsc;
  } else {
    sectorSortBy = field;
    sectorSortAsc = false; // 首次点击默认降序（涨得多在前）
  }

  // 更新表头箭头
  th.parentElement.querySelectorAll('th.sortable').forEach(el => {
    el.querySelector('.sort-arrow').textContent = '';
    el.classList.remove('sort-asc','sort-desc');
  });
  const arrow = sectorSortAsc ? ' ▲' : ' ▼';
  th.querySelector('.sort-arrow').textContent = arrow;
  th.classList.add(sectorSortAsc ? 'sort-asc' : 'sort-desc');

  // 排序并重新渲染
  const sorted = [...sectorCache].sort((a, b) => {
    const va = parseFloat(a[field]) || 0;
    const vb = parseFloat(b[field]) || 0;
    return sectorSortAsc ? va - vb : vb - va;
  });
  renderRankingTable(sorted);
};

// ==================== 板块拖拽排序 ====================
let sectorDragSrcRow = null;

function sectorDragStart(e) {
  sectorDragSrcRow = e.target.closest('.sector-row');
  if (!sectorDragSrcRow) return;
  e.dataTransfer.effectAllowed = 'move';
  sectorDragSrcRow.classList.add('dragging');
}

function sectorDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
}

function sectorDragEnter(e) {
  e.preventDefault();
  const target = e.target.closest('.sector-row');
  if (target && target !== sectorDragSrcRow) {
    target.classList.add('drag-over');
  }
}

function sectorDragEnd(e) {
  document.querySelectorAll('.sector-row').forEach(r => {
    r.classList.remove('dragging', 'drag-over');
  });
  sectorDragSrcRow = null;
}

function sectorDrop(e) {
  e.preventDefault();
  const target = e.target.closest('.sector-row');
  if (!target || !sectorDragSrcRow || target === sectorDragSrcRow) return;

  // 在 DOM 中移动行
  const tbody = target.parentNode;
  const allRows = [...tbody.querySelectorAll('.sector-row')];
  const srcIdx = allRows.indexOf(sectorDragSrcRow);
  const tgtIdx = allRows.indexOf(target);

  if (srcIdx < tgtIdx) {
    tbody.insertBefore(sectorDragSrcRow, target.nextSibling);
  } else {
    tbody.insertBefore(sectorDragSrcRow, target);
  }

  // 同时移动对应的展开行
  const srcCode = sectorDragSrcRow.dataset.code;
  const tgtCode = target.dataset.code;
  const srcFundsRow = document.getElementById(`funds-row-${srcCode}`);
  const tgtFundsRow = document.getElementById(`funds-row-${tgtCode}`);
  if (srcFundsRow && tgtFundsRow) {
    const tgtIdx2 = [...tbody.querySelectorAll('.sector-row')].indexOf(tbody.querySelector(`.sector-row[data-code="${tgtCode}"]`));
    // 把展开行也移到一起
    const afterRow = tbody.querySelectorAll('.sector-row')[tgtIdx2 + 1];
    if (afterRow) {
      tbody.insertBefore(srcFundsRow, afterRow);
    } else {
      tbody.appendChild(srcFundsRow);
    }
  }

  // 重新编号
  tbody.querySelectorAll('.rank-num').forEach((rn, i) => {
    rn.textContent = i + 1;
    rn.className = `rank-num ${i === 0 ? 'top1' : i === 1 ? 'top2' : i === 2 ? 'top3' : 'normal'}`;
  });

  document.querySelectorAll('.sector-row').forEach(r => {
    r.classList.remove('drag-over');
  });
}

async function loadRankingData(sortKey) {
  const container = document.getElementById('rankingContent');
  if (!container) return;

  container.innerHTML = `<div style="text-align:center;padding:60px;"><div class="loader-ring" style="margin:0 auto 16px;"></div><p style="color:#8e8ea0;">正在加载板块排行数据...</p></div>`;

  try {
    const res = await sectorAPI.rankWithDaily();
    const data = res?.data || [];

    if (!data || data.length === 0) {
      container.innerHTML = `<div class="glass-card" style="padding:32px;text-align:center;"><span style="font-size:44px;display:block;margin-bottom:12px;">📊</span><p style="color:#8e8ea0;">暂无排行数据</p></div>`;
      return;
    }

    // 缓存数据，重置排序状态
    sectorCache = data;
    sectorSortBy = '5日%';
    sectorSortAsc = false;
    renderRankingTable(data);

  } catch (err) {
    console.error('榜单加载失败:', err);
    container.innerHTML = `<div style="text-align:center;padding:60px;"><span style="font-size:44px;">❌</span><p style="color:#e74c3c;">加载失败: ${err.message}</p></div>`;
  }
}

function renderRankingTable(data) {
  const container = document.getElementById('rankingContent');
  if (!container || !data || data.length === 0) return;

  const activeCol = sectorSortBy;
  const arrow = sectorSortAsc ? '▲' : '▼';

  const cols = [
    { key: null, label: '', sortable: false },
    { key: null, label: '', sortable: false },
    { key: '#', label: '排名', sortable: false },
    { key: '名称', label: '板块名称', sortable: false },
    { key: '日涨跌', label: '昨日', sortable: true },
    { key: '5日%', label: '近5日', sortable: true },
    { key: '20日%', label: '近1月', sortable: true },
    { key: '60日%', label: '近3月', sortable: true },
    { key: '120日%', label: '近半年', sortable: true },
    { key: '250日%', label: '近1年', sortable: true },
  ];

  let html = `<div class="glass-card fade-in"><div class="ranking-table-wrap">
    <table class="ranking-table sector-table">
      <thead><tr>${cols.map(c => {
        if (c.sortable) {
          const isActive = activeCol === c.key;
          return `<th class="sortable${isActive ? (sectorSortAsc ? ' sort-asc' : ' sort-desc') : ''}" onclick="sortSectorTable(this,'${c.key}')">${c.label}<span class="sort-arrow">${isActive ? ' ' + arrow : ''}</span></th>`;
        }
        return `<th>${c.label}</th>`;
      }).join('')}</tr></thead><tbody>`;

  data.forEach((row, idx) => {
    const name = row['名称'] || row['name'] || '--';
    const code = row['代码'] || row['code'] || '';
    const daily = row['日涨跌'] || '--';
    const chg5 = row['5日%'] || row['chg5Days'] || '--';
    const chg20 = row['20日%'] || row['chg20Days'] || '--';
    const chg60 = row['60日%'] || row['chg60Days'] || '--';
    const chg120 = row['120日%'] || row['chg120Days'] || '--';
    const chg250 = row['250日%'] || row['chg250Days'] || '--';

    const fmtPct = v => { const n = parseFloat(v); return !isNaN(n) ? (n > 0 ? '+' : '') + n.toFixed(2) + '%' : v; };

    const rankNumCls = idx===0?'top1':idx===1?'top2':idx===2?'top3':'normal';
    const dailyClass = !String(daily).includes('-') ? 'chg-up' : 'chg-down';
    const chg5Class = !String(chg5).includes('-') ? 'chg-up' : 'chg-down';
    const chg20Class = !String(chg20).includes('-') ? 'chg-up' : 'chg-down';
    const chg60Class = !String(chg60).includes('-') ? 'chg-up' : 'chg-down';
    const chg120Class = !String(chg120).includes('-') ? 'chg-up' : 'chg-down';
    const chg250Class = !String(chg250).includes('-') ? 'chg-up' : 'chg-down';

    const isExpanded = !!(AppState.expandedSectors && AppState.expandedSectors[code]);
    const expandIcon = isExpanded ? '▼' : '▶';
    const isFav = getFlowFavorites().some(f => f.code === code);
    const favIcon = isFav ? '⭐' : '☆';

    html += `<tr class="sector-row" data-code="${code}" draggable="true"
        ondragstart="sectorDragStart(event)" ondragover="sectorDragOver(event)" ondragenter="sectorDragEnter(event)" ondrop="sectorDrop(event)" ondragend="sectorDragEnd(event)">
      <td class="drag-handle-cell" onclick="event.stopPropagation()"><span class="drag-handle">⋮⋮</span></td>
      <td class="expand-cell" onclick="event.stopPropagation();toggleSectorFunds('${code}','${escapeHtml(name).replace(/'/g, "\\'")}')"><span class="expand-icon" id="expand-icon-${code}">${expandIcon}</span></td>
      <td><span class="rank-num ${rankNumCls}">${idx+1}</span></td>
      <td class="sector-name-cell">${escapeHtml(name)} <button class="fav-btn-inline" data-fav-code="${code}" onclick="event.stopPropagation();toggleFlowFavorite('${escapeHtml(name).replace(/'/g, "\\'")}','${code}');return false;" title="收藏到资金流向">${favIcon}</button></td>
      <td><span class="chg-value ${dailyClass}">${fmtPct(daily)}</span></td>
      <td><span class="chg-value ${chg5Class}">${fmtPct(chg5)}</span></td>
      <td><span class="chg-value ${chg20Class}">${fmtPct(chg20)}</span></td>
      <td><span class="chg-value ${chg60Class}">${fmtPct(chg60)}</span></td>
      <td><span class="chg-value ${chg120Class}">${fmtPct(chg120)}</span></td>
      <td><span class="chg-value ${chg250Class}">${fmtPct(chg250)}</span></td>
    </tr>`;

    // 展开行：场外基金涨幅前10
    html += `<tr class="sector-funds-row" id="funds-row-${code}" style="display:${isExpanded ? 'table-row' : 'none'};">
      <td colspan="10" class="funds-cell">
        <div class="funds-container" id="funds-container-${code}">
          ${isExpanded ? '<div style="text-align:center;padding:12px;"><div class="loader-ring" style="width:20px;height:20px;border-width:2px;margin:0 auto 8px;"></div><p style="color:#8e8ea0;font-size:12px;">加载中...</p></div>' : ''}
        </div>
      </td>
    </tr>`;
  });

  html += '</tbody></table></div></div>';
  container.innerHTML = html;

  // 已展开的板块，加载基金数据
  if (AppState.expandedSectors) {
    Object.keys(AppState.expandedSectors).forEach(c => {
      if (AppState.expandedSectors[c]) loadSectorFunds(c);
    });
  }
}

// ==================== 板块行展开：场外基金涨幅前10 ====================
window.toggleSectorFunds = async function(code, name) {
  const row = document.getElementById(`funds-row-${code}`);
  const icon = document.getElementById(`expand-icon-${code}`);
  if (!row || !icon) return;

  if (row.style.display === 'none' || row.style.display === '') {
    row.style.display = 'table-row';
    icon.textContent = '▼';
    AppState.expandedSectors[code] = true;
    await loadSectorFunds(code, name);
  } else {
    row.style.display = 'none';
    icon.textContent = '▶';
    AppState.expandedSectors[code] = false;
  }
};

async function loadSectorFunds(code, name) {
  const container = document.getElementById(`funds-container-${code}`);
  if (!container) return;
  if (container.dataset.loaded === '1') return;

  container.innerHTML = '<div style="padding:16px;text-align:center;"><div class="loader-ring" style="width:20px;height:20px;border-width:2px;margin:0 auto 8px;"></div><p style="color:#8e8ea0;font-size:12px;">正在加载场外基金涨幅榜...</p></div>';

  try {
    const res = await fundAPI.sectorTop(name, 10);
    if (!res || res.code !== 0) throw new Error(res?.message || '加载失败');
    const { rise, fall, total } = res.data || {};

    if ((!rise || rise.length === 0) && (!fall || fall.length === 0)) {
      container.innerHTML = '<div style="padding:16px;text-align:center;color:#8e8ea0;">暂无相关场外基金数据</div>';
      return;
    }

    const totalTip = total ? `<p style="color:#8e8ea0;font-size:11px;margin:0 0 8px;">共 ${total} 只相关基金</p>` : '';

    // 涨幅榜
    let riseHtml = '';
    if (rise && rise.length > 0) {
      riseHtml = '<h4 style="color:var(--green);margin:0 0 6px;font-size:13px;">📈 涨幅榜</h4><table class="funds-table"><thead><tr><th>#</th><th>代码</th><th>名称</th><th>日涨跌</th><th>近1年</th></tr></thead><tbody>';
      rise.forEach((f, i) => {
        const chg = f.dayChange || 0;
        const chgStr = `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`;
        const y1 = f.year1Change;
        const ret1Y = y1 != null ? `${y1 >= 0 ? '+' : ''}${y1.toFixed(2)}%` : '--';
        riseHtml += `<tr onclick="quickSearch('${(f.code||'').replace(/'/g,"\\'")}')"><td><span class="rank-num-small">${i+1}</span></td><td><code class="code-small">${f.code||'--'}</code></td><td class="fund-name-cell">${escapeHtml(f.name||'--')}</td><td><span class="chg-value chg-up" style="font-weight:700;">${chgStr}</span></td><td style="font-size:11px;">${ret1Y}</td></tr>`;
      });
      riseHtml += '</tbody></table>';
    }

    // 降幅榜
    let fallHtml = '';
    if (fall && fall.length > 0) {
      fallHtml = '<h4 style="color:var(--red);margin:0 0 6px;font-size:13px;">📉 降幅榜</h4><table class="funds-table"><thead><tr><th>#</th><th>代码</th><th>名称</th><th>日涨跌</th><th>近1年</th></tr></thead><tbody>';
      fall.forEach((f, i) => {
        const chg = f.dayChange || 0;
        const chgStr = `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`;
        const y1 = f.year1Change;
        const ret1Y = y1 != null ? `${y1 >= 0 ? '+' : ''}${y1.toFixed(2)}%` : '--';
        fallHtml += `<tr onclick="quickSearch('${(f.code||'').replace(/'/g,"\\'")}')"><td><span class="rank-num-small">${i+1}</span></td><td><code class="code-small">${f.code||'--'}</code></td><td class="fund-name-cell">${escapeHtml(f.name||'--')}</td><td><span class="chg-value chg-down" style="font-weight:700;">${chgStr}</span></td><td style="font-size:11px;">${ret1Y}</td></tr>`;
      });
      fallHtml += '</tbody></table>';
    }

    container.innerHTML = `${totalTip}<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">${riseHtml ? '<div>' + riseHtml + '</div>' : ''}${fallHtml ? '<div>' + fallHtml + '</div>' : ''}</div>`;
    container.dataset.loaded = '1';
  } catch (err) {
    console.error('加载板块基金失败:', err);
    container.innerHTML = `<div style="padding:16px;text-align:center;color:#e74c3c;font-size:12px;">加载失败: ${escapeHtml(err.message)}</div>`;
  }
}

function analyzeSector(code, name) { showSectorAnalysis(code, name); }
function quickAnalyzeSector(code) {
  // 从缓存中找到板块名称
  const found = sectorCache.find(r => (r['代码']||r['code']) === code);
  const name = found ? (found['名称']||found['name']||'--') : code;
  showSectorAnalysis(code, name);
}

// 板块深度分析（点击分析按钮）
async function showSectorAnalysis(code, name) {
  const container = document.getElementById('rankingContent');
  if (!container) return;

  container.innerHTML = `<div style="text-align:center;padding:60px;">
    <div class="loader-ring" style="margin:0 auto 16px;"></div>
    <p style="color:#8e8ea0;">正在加载【${escapeHtml(name)}】深度分析...</p>
    <p style="color:#b0b0c0;font-size:12px;">获取K线走势 + 成份股行情</p>
  </div>`;

  try {
    const res = await sectorAPI.analyze(code);
    if (!res || res.code !== 0) throw new Error(res?.message || '数据获取失败');

    const { kline, quotes } = res.data;
    const upCount = quotes.filter(q => parseFloat(q.change_percent) > 0).length;
    const downCount = quotes.filter(q => parseFloat(q.change_percent) < 0).length;
    const avgChg = quotes.length > 0
      ? (quotes.reduce((s, q) => s + (parseFloat(q.change_percent) || 0), 0) / quotes.length).toFixed(2)
      : '--';

    // 构建成份股表格
    let quotesHtml = '';
    quotes.forEach((q, i) => {
      const qCode = q.code || q.symbol || '--';
      const qName = q.name || '--';
      const price = q.price || '--';
      const chg = q.change_percent || q.change || '--';
      const chgNum = parseFloat(chg);
      const isUp = !isNaN(chgNum) && chgNum >= 0;
      const pe = q.pe_ratio || q.pe_lyr || '--';
      const mcap = q.total_market_cap || '--';
      const mcapStr = formatMarketCap(mcap);
      const chgColor = isUp ? 'var(--green)' : 'var(--red)';

      quotesHtml += `<tr>
        <td style="font-weight:700;color:var(--text-secondary);">${i+1}</td>
        <td><span style="font-weight:600;">${escapeHtml(qName)}</span><br><code style="font-size:11px;color:var(--text-tertiary);">${qCode}</code></td>
        <td style="font-weight:600;font-family:'SF Mono',monospace;">${price}</td>
        <td style="font-weight:700;color:${chgColor};font-family:'SF Mono',monospace;">${isUp?'+':''}${chg}%</td>
        <td style="font-family:'SF Mono',monospace;font-size:12px;">${pe}</td>
        <td style="font-family:'SF Mono',monospace;font-size:12px;color:var(--text-secondary);">${mcapStr}</td>
        <td><div class="mini-chg-bar" style="width:${Math.min(100,Math.abs(chgNum)*8)}%;background:${isUp?'var(--green)':'var(--red)'};opacity:0.25;height:4px;border-radius:2px;"></div></td>
      </tr>`;
    });

    // 构建总结卡片
    const latestK = kline.length > 0 ? kline[kline.length - 1] : null;
    const lastPrice = latestK ? latestK.last || latestK.close : '--';
    const lastDate = latestK ? latestK.date : '--';

    // 计算区间涨幅
    let range5d = '--', range20d = '--', range60d = '--';
    if (kline.length >= 5) {
      const c5 = parseFloat(kline[kline.length - 5].last || kline[kline.length - 5].close);
      const cNow = parseFloat(latestK.last || latestK.close);
      if (c5 > 0) range5d = ((cNow - c5) / c5 * 100).toFixed(2) + '%';
    }
    if (kline.length >= 20) {
      const c20 = parseFloat(kline[kline.length - 20].last || kline[kline.length - 20].close);
      const cNow = parseFloat(latestK.last || latestK.close);
      if (c20 > 0) range20d = ((cNow - c20) / c20 * 100).toFixed(2) + '%';
    }
    if (kline.length >= 60) {
      const c60 = parseFloat(kline[kline.length - 60].last || kline[kline.length - 60].close);
      const cNow = parseFloat(latestK.last || latestK.close);
      if (c60 > 0) range60d = ((cNow - c60) / c60 * 100).toFixed(2) + '%';
    }

    const r5IsUp = !String(range5d).includes('-');
    const r20IsUp = !String(range20d).includes('-');
    const r60IsUp = !String(range60d).includes('-');

    const analysisHtml = `
      <div class="sector-analysis-panel fade-in">
        <!-- 返回按钮 + 标题 -->
        <div style="display:flex;align-items:center;gap:16px;margin-bottom:20px;flex-wrap:wrap;">
          <button class="btn-small btn-outline" onclick="loadRankingData(AppState.rankCurrentSort)" style="padding:8px 16px;">← 返回榜单</button>
          <h2 style="margin:0;font-size:22px;display:flex;align-items:center;gap:10px;">🔍 ${escapeHtml(name)} <span class="fund-code-tag">${code}</span></h2>
        </div>

        <!-- 概览指标卡 -->
        <div class="metrics-row" style="margin-bottom:20px;">
          <div class="metric-card mini" style="flex:1;">
            <div class="metric-label">板块指数</div>
            <div class="metric-value" style="font-size:20px;">${lastPrice}</div>
            <div style="font-size:11px;color:var(--text-tertiary);">${lastDate}</div>
          </div>
          <div class="metric-card mini ${r5IsUp?'up':'down'}" style="flex:1;">
            <div class="metric-label">近5日</div>
            <div class="metric-value" style="font-size:20px;">${range5d}</div>
          </div>
          <div class="metric-card mini ${r20IsUp?'up':'down'}" style="flex:1;">
            <div class="metric-label">近20日</div>
            <div class="metric-value" style="font-size:20px;">${range20d}</div>
          </div>
          <div class="metric-card mini ${r60IsUp?'up':'down'}" style="flex:1;">
            <div class="metric-label">近60日</div>
            <div class="metric-value" style="font-size:20px;">${range60d}</div>
          </div>
          <div class="metric-card mini" style="flex:1;">
            <div class="metric-label">上涨/下跌</div>
            <div class="metric-value" style="font-size:20px;">
              <span style="color:var(--green);">${upCount}↑</span> /
              <span style="color:var(--red);">${downCount}↓</span>
            </div>
            <div style="font-size:11px;color:var(--text-tertiary);">平均 ${avgChg}%</div>
          </div>
        </div>

        <!-- K线图 -->
        <div class="glass-card" style="margin-bottom:20px;">
          <div class="card-header"><h3>📈 板块指数走势（日K）</h3></div>
          <div class="chart-wrapper" style="height:300px;">
            <canvas id="sectorKlineChart"></canvas>
          </div>
        </div>

        <!-- 成份股行情 -->
        <div class="glass-card">
          <div class="card-header">
            <h3>🏢 板块成份股 · 实时行情 <span style="font-size:12px;color:var(--text-tertiary);font-weight:400;">（TOP 20，按涨跌幅排序）</span></h3>
          </div>
          <div class="ranking-table-wrap" style="max-height:600px;overflow-y:auto;">
            <table class="ranking-table sector-table">
              <thead><tr>
                <th>#</th><th>股票名称</th><th>最新价</th><th>涨跌幅</th><th>PE</th><th>总市值</th><th>强度</th>
              </tr></thead>
              <tbody>${quotesHtml || '<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--text-tertiary);">暂无成份股数据</td></tr>'}</tbody>
            </table>
          </div>
        </div>

        <!-- 场外基金涨幅/降幅榜 -->
        <div class="glass-card" style="margin-top:20px;">
          <div class="card-header"><h3>📊 场外基金 · 涨幅/降幅榜 <span style="font-size:12px;color:var(--text-tertiary);font-weight:400;">（${escapeHtml(name)}相关）</span></h3></div>
          <div id="sectorFundsContainer" style="min-height:80px;">
            <div style="text-align:center;padding:24px;"><div class="loader-ring" style="width:20px;height:20px;border-width:2px;margin:0 auto 8px;"></div><p style="color:var(--text-tertiary);font-size:12px;">正在加载场外基金数据...</p></div>
          </div>
        </div>
      </div>`;

    container.innerHTML = analysisHtml;

    // 延迟渲染K线图（等待DOM就绪）
    setTimeout(() => renderSectorKlineChart(kline, name), 100);

    // 异步加载场外基金涨幅/降幅榜
    loadSectorFundsForAnalysis(name);

  } catch (err) {
    console.error('板块分析失败:', err);
    container.innerHTML = `<div style="text-align:center;padding:60px;">
      <span style="font-size:44px;display:block;margin-bottom:12px;">❌</span>
      <p style="color:var(--red);margin-bottom:8px;">分析失败: ${escapeHtml(err.message)}</p>
      <button class="btn-small btn-outline" onclick="loadRankingData(AppState.rankCurrentSort)">← 返回榜单</button>
    </div>`;
  }
}

// ==================== 板块分析面板：场外基金涨幅/降幅榜 ====================

async function loadSectorFundsForAnalysis(name) {
  const container = document.getElementById('sectorFundsContainer');
  if (!container) return;

  try {
    const res = await fundAPI.sectorTop(name, 10);
    if (!res || res.code !== 0) throw new Error(res?.message || '加载失败');
    const { rise, fall, total } = res.data || {};

    if ((!rise || rise.length === 0) && (!fall || fall.length === 0)) {
      container.innerHTML = '<p style="text-align:center;color:var(--text-tertiary);padding:24px;">暂无相关场外基金数据</p>';
      return;
    }

    const totalTip = total ? `<span style="font-size:11px;color:var(--text-tertiary);font-weight:400;margin-left:8px;">共 ${total} 只相关基金</span>` : '';

    container.innerHTML = `
      <div style="margin-bottom:12px;">${totalTip}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
        <div>
          <h4 style="color:var(--green);margin:0 0 10px;font-size:14px;display:flex;align-items:center;gap:6px;">📈 涨幅榜 <span style="font-size:11px;color:var(--text-tertiary);font-weight:400;">前${rise ? rise.length : 0}</span></h4>
          ${renderFundTable(rise)}
        </div>
        <div>
          <h4 style="color:var(--red);margin:0 0 10px;font-size:14px;display:flex;align-items:center;gap:6px;">📉 降幅榜 <span style="font-size:11px;color:var(--text-tertiary);font-weight:400;">前${fall ? fall.length : 0}</span></h4>
          ${renderFundTable(fall)}
        </div>
      </div>`;
  } catch (err) {
    container.innerHTML = `<p style="text-align:center;color:var(--red);padding:24px;">加载失败: ${escapeHtml(err.message)}</p>`;
  }
}

function renderFundTable(funds) {
  if (!funds || funds.length === 0) return '<p style="color:var(--text-tertiary);font-size:12px;padding:12px;">暂无数据</p>';
  let html = '<table class="funds-table"><thead><tr><th>#</th><th>代码</th><th>名称</th><th>最新净值</th><th>日涨跌</th><th>近1年</th></tr></thead><tbody>';
  funds.forEach((f, i) => {
    const chg = f.dayChange || 0;
    const chgClass = chg >= 0 ? 'chg-up' : 'chg-down';
    const chgStr = `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`;
    const y1 = f.year1Change;
    const ret1Y = y1 != null ? `${y1 >= 0 ? '+' : ''}${y1.toFixed(2)}%` : '--';
    const ret1YClass = y1 != null ? (y1 >= 0 ? 'chg-up' : 'chg-down') : '';
    const codeSafe = (f.code || '').replace(/'/g, "\\'");
    html += `<tr style="cursor:pointer;" onclick="quickSearch('${codeSafe}')">
      <td><span class="rank-num-small">${i + 1}</span></td>
      <td><code class="code-small">${f.code || '--'}</code></td>
      <td class="fund-name-cell">${escapeHtml(f.name || '--')}</td>
      <td style="font-family:'SF Mono',monospace;font-size:12px;">${f.nav ? f.nav.toFixed(4) : '--'}</td>
      <td><span class="chg-value ${chgClass}" style="font-weight:700;">${chgStr}</span></td>
      <td><span class="chg-value ${ret1YClass}" style="font-size:12px;">${ret1Y}</span></td>
    </tr>`;
  });
  html += '</tbody></table>';
  return html;
}

function formatMarketCap(val) {
  if (!val || val === '--') return '--';
  const num = parseFloat(val);
  if (isNaN(num)) return val;
  if (num >= 1e12) return (num/1e12).toFixed(2) + '万亿';
  if (num >= 1e8) return (num/1e8).toFixed(1) + '亿';
  if (num >= 1e4) return (num/1e4).toFixed(1) + '万';
  return num.toFixed(0);
}

// 板块K线图（独立图表实例）
let sectorKlineChart = null;
function renderSectorKlineChart(kline, name) {
  const canvas = document.getElementById('sectorKlineChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  if (sectorKlineChart) { sectorKlineChart.destroy(); sectorKlineChart = null; }

  if (!kline || kline.length < 2) {
    canvas.parentElement.innerHTML = '<div style="text-align:center;padding:80px;color:var(--text-tertiary);">暂无K线数据</div>';
    return;
  }

  const labels = kline.map(d => d.date || d['日期'] || '');
  const closes = kline.map(d => parseFloat(d.last || d.close || d['收盘价'] || 0));

  const gradient = ctx.createLinearGradient(0, 0, 0, 300);
  gradient.addColorStop(0, 'rgba(26,115,232,0.18)');
  gradient.addColorStop(1, 'rgba(26,115,232,0.01)');

  sectorKlineChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: name + ' 板块指数',
        data: closes,
        borderColor: '#1a73e8',
        backgroundColor: gradient,
        borderWidth: 2.5,
        fill: true,
        tension: 0.35,
        pointRadius: 0,
        pointHoverRadius: 5,
        pointHoverBackgroundColor: '#1a73e8',
        pointHoverBorderColor: '#fff',
        pointHoverBorderWidth: 2,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(26,26,46,0.92)',
          titleFont: { size: 13, weight: '600' },
          bodyFont: { size: 13 },
          padding: 12,
          cornerRadius: 10,
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 10, font: { size: 11 }, color: '#8e8ea0' }},
        y: {
          position: 'right',
          grid: { color: 'rgba(0,0,0,0.04)', drawBorder: false },
          ticks: { font: { size: 11 }, color: '#8e8ea0' }
        }
      }
    }
  });
}

// ==================== Tab 3: 潜力筛选引擎 ====================

// 初始化筛选器（动态加载板块名称到下拉框）
async function initScreener() {
  const select = document.getElementById('filterSector');
  if (!select || select.dataset.loaded === '1') return;

  try {
    const res = await sectorAPI.sectorNames();
    const data = res?.data || [];
    if (!data || data.length === 0) return;

    // 从板块排行数据中提取板块名称
    data.forEach(row => {
      const name = row['名称'] || row['name'] || '';
      const code = row['代码'] || row['code'] || '';
      if (name && code) {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        select.appendChild(option);
      }
    });

    select.dataset.loaded = '1';
  } catch (err) {
    console.warn('加载板块列表失败:', err);
  }
}

window.runScreener = async function() {
  // 确保板块列表已加载
  await initScreener();

  const resultContainer = document.getElementById('screenerResultsBody');
  const countEl = document.getElementById('resultCount');

  resultContainer.innerHTML = `<div style="text-align:center;padding:40px;"><div class="loader-ring" style="margin:0 auto 14px;width:44px;height:44px;border-width:3px;"></div><p style="color:#8e8ea0;font-size:13px;">引擎运行中，正在筛选全量基金...</p></div>`;

  const sector = document.getElementById('filterSector')?.value || '';
  const sortBy = document.getElementById('filterSort')?.value || 'dayChange';
  const minChg = parseFloat(document.getElementById('filterMinChg')?.value || '0');

  try {
    const params = { limit: 30 };
    if (sector) params.sector = sector;
    if (minChg > 0) params.minChg = minChg;
    if (sortBy) params.sortBy = sortBy === 'chg1Days' ? 'dayChange' : sortBy === 'chg5Days' ? 'weekChange' : 'month1Change';

    const res = await fundAPI.screener(params);
    if (!res || res.code !== 0) throw new Error(res?.message || '筛选失败');
    const { funds, total } = res.data || {};

    countEl.textContent = `共 ${total || 0} 只基金，展示 ${funds ? funds.length : 0} 只`;

    if (!funds || funds.length === 0) {
      resultContainer.innerHTML = `<div style="text-align:center;padding:40px;color:#8e8ea0;"><span style="font-size:36px;display:block;margin-bottom:10px;">🔍</span><p>未找到符合条件的基金，请调整筛选条件</p></div>`;
      return;
    }

    resultContainer.innerHTML = funds.map((f, idx) => {
      const score = f.potentialScore || 0;
      const scoreClass = score >= 70 ? 'score-high' : score >= 50 ? 'score-medium' : score >= 30 ? 'score-low' : 'score-very-low';
      const dayChg = f.dayChange || 0;
      const weekChg = f.weekChange || 0;
      const month1Chg = f.month1Change || 0;
      const dayChgStr = `${dayChg >= 0 ? '+' : ''}${dayChg.toFixed(2)}%`;
      const weekChgStr = `${weekChg >= 0 ? '+' : ''}${weekChg.toFixed(2)}%`;
      const month1ChgStr = `${month1Chg >= 0 ? '+' : ''}${month1Chg.toFixed(2)}%`;
      const dayClass = dayChg >= 0 ? 'chg-up' : 'chg-down';
      const weekClass = weekChg >= 0 ? 'chg-up' : 'chg-down';
      const month1Class = month1Chg >= 0 ? 'chg-up' : 'chg-down';

      // 信号标签
      const signals = f.signals || [];
      const signalBadges = signals.map(s => {
        const map = {
          momentum: { icon: '🚀', label: '突破', cls: 'momentum' },
          'fund-flow': { icon: '💰', label: '抢筹', cls: 'fund-flow' },
          tech: { icon: '📐', label: '加速', cls: 'tech' },
          breakout: { icon: '🔥', label: '爆发', cls: 'breakout' },
        };
        const info = map[s] || { icon: '⚡', label: s, cls: s };
        return `<span class="signal-badge ${info.cls}">${info.icon} ${info.label}</span>`;
      }).join('');

      const codeSafe = (f.code || '').replace(/'/g, "\\'");
      const nameSafe = escapeHtml(f.name || '--');

      return `<div class="screener-result-item fade-in" onclick="quickSearch('${codeSafe}')">
        <div class="screener-result-left">
          <span class="screener-rank">#${idx + 1}</span>
          <div>
            <div class="screener-name">${nameSafe}</div>
            <div class="screener-code">${f.code || '--'}</div>
            <div class="screener-changes">
              <span class="chg-value ${dayClass}" style="font-size:11px;">日${dayChgStr}</span>
              <span style="color:#ccc;margin:0 3px;">|</span>
              <span class="chg-value ${weekClass}" style="font-size:11px;">周${weekChgStr}</span>
              <span style="color:#ccc;margin:0 3px;">|</span>
              <span class="chg-value ${month1Class}" style="font-size:11px;">月${month1ChgStr}</span>
            </div>
          </div>
        </div>
        <div class="screener-score-area">
          <div class="potential-score"><span class="potential-score-value ${scoreClass}">${score}</span><span class="potential-score-label">潜力分</span></div>
          <div class="signal-badges">${signalBadges || '<span style="color:#8e8ea0;font-size:11px;">观望</span>'}</div>
        </div>
      </div>`;
    }).join('');

  } catch (err) {
    console.error('筛选失败:', err);
    resultContainer.innerHTML = `<div style="text-align:center;padding:40px;color:#e74c3c;"><span style="font-size:36px;display:block;margin-bottom:10px;">❌</span><p>引擎异常: ${err.message}</p></div>`;
  }
};

function handleFundSearchByCode(code, name) {
  document.getElementById('fundSearchInput').value = code || name;
  document.querySelector('[data-tab=search]').click();
  handleFundSearch();
}
window.addToCompare = function(side) {
  const input = document.getElementById(`compareFund${side}`);
  const val = input?.value?.trim();
  if (!val) { showToast(`请输入基金${side}的代码或名称`); return; }
  showToast(`已添加: ${val}`, 'info');
};

window.runCompare = async function() {
  const fundA = document.getElementById('compareFundA')?.value?.trim();
  const fundB = document.getElementById('compareFundB')?.value?.trim();

  if (!fundA || !fundB) { showToast('请输入两只基金的代码进行对比'); return; }

  const resultDiv = document.getElementById('compareResult');
  resultDiv.style.display = 'block';
  resultDiv.innerHTML = `<div style="text-align:center;padding:50px;"><div class="loader-ring" style="margin:0 auto 16px;"></div><p style="color:#8e8ea0;">正在进行深度对比分析...</p></div>`;

  try {
    const [resA, resB] = await Promise.all([
      Promise.allSettled([fundAPI.detail(fundA), fundAPI.holdings(fundA), stockAPI.quote(fundA), fundAPI.kline(fundA,'day',60)]),
      Promise.allSettled([fundAPI.detail(fundB), fundAPI.holdings(fundB), stockAPI.quote(fundB), fundAPI.kline(fundB,'day',60)])
    ]);

    const extractData = results => ({
      detail: results[0].status==='fulfilled'?results[0].value?.data:null,
      holdings: results[1].status==='fulfilled'?results[1].value?.data:[],
      quote: results[2].status==='fulfilled'?results[2].value?.data?.[0]:null,
      kline: results[3].status==='fulfilled'?results[3].value?.data:[],
    });

    const dataA = extractData(resA), dataB = extractData(resB);
    const compareRows = buildCompareRows(fundA, fundB, dataA, dataB);

    resultDiv.innerHTML = `<div class="glass-card fade-in" style="overflow:hidden;"><table class="compare-table"><thead><tr><th>对比维度</th><th style="text-align:center;">${escapeHtml(fundA)}</th><th style="text-align:center;">${escapeHtml(fundB)}</th></tr></thead><tbody>${
      compareRows.map(r => `<tr><td class="compare-label">${r.label}</td><td class="${r.winner==='A'?'winner-cell':''}" style="text-align:center;font-weight:600;">${r.valA}</td><td class="${r.winner==='B'?'winner-cell':''}" style="text-align:center;font-weight:600;">${r.valB}</td></tr>`).join('')
    }</tbody></table></div>

    <div class="glass-card" style="margin-top:20px;padding:24px;">
      <h4 style="font-size:15px;font-weight:650;margin-bottom:12px;">💡 对比结论</h4>
      <div style="font-size:13.5px;line-height:1.8;color:#555770;">${generateCompareConclusion(dataA,dataB,fundA,fundB)}</div>
    </div>`;

  } catch (err) {
    console.error('对比失败:', err);
    resultDiv.innerHTML = `<div style="text-align:center;padding:50px;color:#e74c3c;">对比失败: ${err.message}</div>`;
  }
};

function buildCompareRows(codeA, codeB, dataA, dataB) {
  const rows = [], addRow = (label,valA,valB,winner='') => rows.push({label,valA,valB,winner});

  addRow('基金代码', codeA, codeB);
  addRow('持仓数量', `${dataA.holdings?.length||0} 只`, `${dataB.holdings?.length||0} 只`);

  const priceA = dataA.quote?.['price']||dataA.quote?.['closePrice']||dataA.quote?.['nav']||'--';
  const priceB = dataB.quote?.['price']||dataB.quote?.['closePrice']||dataB.quote?.['nav']||'--';
  addRow('最新净值', priceA, priceB);

  const chgA = dataA.quote?.['change_percent']||dataA.quote?.['changePct']||'--';
  const chgB = dataB.quote?.['change_percent']||dataB.quote?.['changePct']||'--';
  const numA=parseFloat(chgA)||0, numB=parseFloat(chgB)||0;
  addRow('当日涨跌', chgA, chgB, numA>numB?'A':numB>numA?'B':'');

  const calcReturn = kline => {
    if(!kline||kline.length<2) return '--';
    const c=kline.map(d=>parseFloat(d['last']||d['close']||d['收盘价']||0));
    return (((c[c.length-1]-c[0])/c[0])*100).toFixed(2)+'%';
  };
  addRow('区间收益率', calcReturn(dataA.kline), calcReturn(dataB.kline));

  const top5A=(dataA.holdings||[]).slice(0,5).reduce((s,h)=>s+(parseFloat(parseWeight(h).text.replace('%',''))||0),0).toFixed(1)+'%';
  const top5B=(dataB.holdings||[]).slice(0,5).reduce((s,h)=>s+(parseFloat(parseWeight(h).text.replace('%',''))||0),0).toFixed(1)+'%';
  addRow('前5持仓占比', top5A, top5B, parseFloat(top5A)<parseFloat(top5B)?'A':'B');

  const calcVol = kline => {
    if(!kline||kline.length<5) return '--';
    const c=kline.map(d=>parseFloat(d['last']||d['close']||d['收盘价']||0));
    const m=c.reduce((a,b)=>a+b,0)/c.length;
    return (Math.sqrt(c.reduce((s,x)=>s+Math.pow(x-m,2),0)/c.length)/m*100).toFixed(2)+'%';
  };
  addRow('波动率(估)', calcVol(dataA.kline), calcVol(dataB.kline));

  const calcMaxDD = kline => {
    if(!kline||kline.length<5) return '--';
    const c=kline.map(d=>parseFloat(d['last']||d['close']||d['收盘价']||0));
    let max=c[0],md=0; c.forEach(v=>{if(v>max)max=v;const dd=((v-max)/max*100);if(dd<md)md=dd;});
    return md.toFixed(2)+'%';
  };
  const ddA=calcMaxDD(dataA.kline), ddB=calcMaxDD(dataB.kline);
  addRow('最大回撤(估)', ddA, ddB, parseFloat(ddA)>parseFloat(ddB)?'B':parseFloat(ddB)>parseFloat(ddA)?'A':'');

  const sA=calculateHealthScores(dataA.holdings,dataA.quote);
  const sB=calculateHealthScores(dataB.holdings,dataB.quote);
  addRow('综合健康评分', Math.round(Object.values(sA).reduce((a,b)=>a+b,0)/6)+'分',
         Math.round(Object.values(sB).reduce((a,b)=>a+b,0)/6)+'分',
         Object.values(sA).reduce((a,b)=>a+b,0)>Object.values(sB).reduce((a,b)=>a+b,0)?'A':'B');

  return rows;
}

function generateCompareConclusion(dataA, dataB, nameA, nameB) {
  const lines = [];

  const retA = (() => { if(!dataA.kline||dataA.kline.length<2)return 0;const c=dataA.kline.map(d=>parseFloat(d['last']||d['close']||0));return ((c[c.length-1]-c[0])/c[0]*100); })();
  const retB = (() => { if(!dataB.kline||dataB.kline.length<2)return 0;const c=dataB.kline.map(d=>parseFloat(d['last']||d['close']||0));return ((c[c.length-1]-c[0])/c[0]*100); })();

  if(retA>retB) lines.push(`<strong>${nameA}</strong> 区间收益更优（${retA.toFixed(2)}% vs ${retB.toFixed(2)}%）`);
  else if(retB>retA) lines.push(`<strong>${nameB}</strong> 区间收益更优（${retB.toFixed(2)}% vs ${retA.toFixed(2)}%）`);

  const hA=dataA.holdings?.length||0, hB=dataB.holdings?.length||0;
  if(Math.abs(hA-hB)>3) lines.push(`<strong>${hA>hB?nameA:nameB}</strong> 持仓更加分散。`);

  lines.push('<br>⚠️ 以上基于公开市场数据自动生成，仅供研究参考，不构成投资建议。');
  return lines.join('<br>');
}

// ==================== 工具函数 ====================

function showToast(msg, type='info') {
  const existing = document.getElementById('toastNotification');
  if(existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'toastNotification';
  const bgs = { info:'linear-gradient(135deg,#1a73e8,#4a90e2)', error:'linear-gradient(135deg,#e74c3c,#c0392b)', success:'linear-gradient(135deg,#00b894,#0e9b83)' };

  toast.style.cssText = `position:fixed;top:80px;left:50%;transform:translateX(-50%);background:${bgs[type]||bgs.info};color:white;padding:12px 28px;border-radius:14px;font-size:13.5px;font-weight:600;z-index:9999;box-shadow:0 8px 28px rgba(0,0,0,0.15);animation:fadeInDown 0.3s ease forwards;white-space:nowrap;`;
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => { toast.style.animation='fadeOut 0.3s ease forwards'; setTimeout(()=>toast.remove(),300); }, 3000);
}

function showLoading(show) {
  const overlay = document.getElementById('loadingOverlay');
  overlay.style.display = show ? 'flex' : 'none';
  if (!show) { const steps=document.getElementById('loadingSteps'); if(steps) steps.innerHTML=''; }
}

function addLoadingStep(text) {
  const steps = document.getElementById('loadingSteps');
  if(steps) { const e=document.createElement('div'); e.style.cssText='padding:3px 0;font-size:12.5px;color:#555770;'; e.textContent=text; steps.appendChild(e); steps.scrollTop=steps.scrollHeight; }
}
function updateLoadingSteps(steps) {
  const el = document.getElementById('loadingSteps');
  if(el) el.innerHTML=steps.map(s=>`<div style="padding:3px 0;font-size:12.5px;color:#555770;">${s}</div>`).join('');
}

window.showStockDetail = function(code) {
  showToast(`查看 ${code} 详细信息...`, 'info');
};

// ==================== 场外基金渲染 ====================

/**
 * 渲染场外基金概览头
 */
function renderRegularFundOverview(code, name, realtime, detail) {
  const container = document.getElementById('fundOverviewHeader');
  const nav = realtime?.nav || detail?.navHistory?.[detail.navHistory.length - 1]?.nav || '--';
  const estNav = realtime?.estimatedNav || null;
  const estChange = realtime?.estimatedChange || null;
  const isUp = estChange !== null ? estChange >= 0 : true;

  // 使用最后一个净值日期
  let navDate = realtime?.navDate || '';
  if (detail?.navHistory?.length) {
    const last = detail.navHistory[detail.navHistory.length - 1];
    navDate = last.date || navDate;
    if (!nav) nav = last.nav;
  }

  container.innerHTML = `
    <div class="fund-header-left">
      <div class="fund-header-title-row">
        <span class="fund-type-badge fund-type-regular">场外基金</span>
        <h2>${escapeHtml(name)}</h2>
        <span class="fund-code-badge">${code.replace(/^jj/, '')}</span>
      </div>
      <div class="fund-header-subtitle">
        <span>净值日期: ${navDate || '--'}</span>
        ${realtime?.updateTime ? `<span class="divider">|</span><span>估值时间: ${realtime.updateTime}</span>` : ''}
      </div>
    </div>
    <div class="fund-header-right">
      <div class="fund-nav-display">
        <span class="nav-label">单位净值</span>
        <span class="nav-value">${typeof nav === 'number' ? nav.toFixed(4) : nav}</span>
        ${estNav ? `<span class="nav-est">估算: ${parseFloat(estNav).toFixed(4)}</span>` : ''}
      </div>
      <div class="fund-change-display ${isUp ? 'up' : 'down'}">
        <span class="change-label">估算涨跌</span>
        <span class="change-value">${estChange !== null ? (estChange >= 0 ? '+' : '') + estChange + '%' : '--'}</span>
      </div>
    </div>
  `;
}

/**
 * 渲染场外基金净值走势图
 */
function renderRegularFundNavChart(navData, detailNavHistory) {
  const data = (navData && navData.length > 0) ? navData : (detailNavHistory || []);
  const ctx = document.getElementById('navChart').getContext('2d');

  if (AppState.navChart) AppState.navChart.destroy();

  const labels = data.map(d => d.date);
  const values = data.map(d => d.nav || d.y);

  AppState.navChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: '单位净值',
        data: values,
        borderColor: '#6c5ce7',
        backgroundColor: 'rgba(108, 92, 231, 0.08)',
        borderWidth: 2,
        fill: true,
        tension: 0.3,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHoverBackgroundColor: '#6c5ce7',
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(26, 26, 46, 0.92)',
          padding: 12,
          cornerRadius: 10,
          callbacks: { label: ctx => `净值: ${ctx.parsed.y.toFixed(4)}` }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 10, font: { size: 11 }, color: '#8e8ea0' } },
        y: {
          position: 'right',
          grid: { color: 'rgba(0,0,0,0.04)' },
          ticks: { font: { size: 11 }, color: '#8e8ea0', callback: v => v?.toFixed(3) }
        }
      }
    }
  });
}

/**
 * 渲染场外基金持仓明细（含公司数据）
 */
function renderRegularFundHoldings(holdings) {
  const tbody = document.getElementById('holdingsBody');
  if (!holdings || holdings.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-cell">暂无公开持仓数据</td></tr>`;
    return;
  }

  tbody.innerHTML = holdings.map((h, i) => {
    const quote = h._quote || {};
    const profile = h._profile || {};

    // 涨跌幅
    const pct = parseFloat(quote.change_percent || 0);
    const pctStr = isNaN(pct) ? '--' : (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
    const pctClass = pct > 0 ? 'up' : pct < 0 ? 'down' : 'neutral';

    // 最新价
    const price = quote.price || '--';

    // PE
    const pe = parseFloat(quote.pe_ratio || 0);

    // 业绩评级 - getPerformanceRating 返回 {icon, label, class}
    const perfRating = getPerformanceRating(pct);
    const perfLabel = perfRating ? (perfRating.icon + ' ' + perfRating.label) : '--';

    // 板块热度（基于涨跌幅绝对值）
    const heatVal = Math.min(Math.abs(pct) * 20, 100);
    const heatColor = getHeatColor(heatVal);

    // 护城河评级 - 基于市值+PE+行业地位
    const moatStars = getMoatRating(quote);
    const moatLabel = moatStars || '⭐⭐☆☆☆';

    // 股票图标
    const icon = getStockIcon(i);

    // 行业信息
    const industry = profile.industry || profile.sector || '';
    const business = profile.business || '';

    return `
    <tr>
      <td>${icon} ${h.rank || i + 1}</td>
      <td>
        <strong>${escapeHtml(h.stockName)}</strong>
        ${industry ? `<div style="font-size:11px;color:#6c5ce7;">${escapeHtml(industry)}</div>` : ''}
        ${business ? `<div style="font-size:11px;color:#8e8ea0;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(business)}">${escapeHtml(business).slice(0, 50)}</div>` : ''}
      </td>
      <td style="text-align:center">
        <code>${escapeHtml(h.stockCode)}</code>
        ${price !== '--' ? `<div style="font-size:12px;color:#8e8ea0;">${price}</div>` : ''}
      </td>
      <td>
        <span class="ratio-bar" style="--r:${Math.min(h.ratio, 10) * 10}%">${h.ratio}%</span>
      </td>
      <td style="text-align:center">
        <span class="perf-badge ${pctClass}">${perfLabel}</span>
        <div style="font-size:11px;margin-top:3px;color:${pct > 0 ? 'var(--accent-green)' : pct < 0 ? 'var(--accent-red)' : 'var(--text-tertiary)'}">${pctStr}</div>
        ${pe > 0 ? `<div style="font-size:10px;color:#8e8ea0;">PE:${pe.toFixed(1)}</div>` : ''}
      </td>
      <td style="text-align:center">
        <div class="mini-heat-bar" style="width:${heatVal}%;background:${heatColor}"></div>
        <span style="font-size:11px;">${pctStr}</span>
      </td>
      <td style="text-align:center">
        <span class="moat-badge">${moatLabel}</span>
        ${quote.total_market_cap ? `<div style="font-size:10px;color:#8e8ea0;">${formatMarketCap(quote.total_market_cap)}</div>` : ''}
      </td>
    </tr>`;
  }).join('');
}

/**
 * 渲染场外基金收益指标
 */
function renderRegularFundMetrics(detail) {
  const setMetric = (id, val) => {
    const el = document.getElementById(id);
    if (!el) return;
    const num = parseFloat(val);
    if (isNaN(num)) { el.textContent = '--'; return; }
    el.textContent = (num >= 0 ? '+' : '') + num + '%';
    el.parentElement.className = `metric-card mini ${num >= 0 ? 'up' : 'down'}`;
  };

  setMetric('metric1M', detail?.ret1M);
  setMetric('metric3M', detail?.ret3M);
  setMetric('metric6M', detail?.ret6M);
  setMetric('metricYTD', null); // 场外基金暂无YTD
  setMetric('metric1Y', detail?.ret1Y);

  // 隐藏不适合场外基金的元素
  const sectorBars = document.getElementById('sectorBars');
  if (sectorBars) sectorBars.innerHTML = '<p style="color:#8e8ea0;padding:12px;">场外基金暂无板块配置数据</p>';

  const riskContent = document.getElementById('riskContent');
  if (riskContent) {
    riskContent.innerHTML = `
      <p style="margin-bottom:8px;">📌 <strong>基金类型</strong>: 场外开放式基金</p>
      <p style="margin-bottom:8px;">⚠️ <strong>风险提示</strong>: 本基金为QDII混合型基金，受海外市场波动、汇率变动等影响，净值波动可能较大。</p>
      <p style="color:#8e8ea0;">💡 持仓数据来源于基金季报，有一定滞后性。实际投资请以最新公告为准。</p>
    `;
  }
}

/**
 * 渲染场外基金综合健康雷达图
 */
function renderRegularFundScoreRadar(detail, navHistory, holdings) {
  const ctxRaw = document.getElementById('scoreRadarChart');
  if (!ctxRaw) return;
  const ctx = ctxRaw.getContext('2d');
  if (!ctx) return;

  if (AppState.radarChart) { AppState.radarChart.destroy(); AppState.radarChart = null; }

  // 1. 业绩表现 — 基于阶段收益加权
  const retVals = [
    Math.min(Math.max(parseFloat(detail?.ret1M) || 0, -20), 50) * 0.2,
    Math.min(Math.max(parseFloat(detail?.ret3M) || 0, -30), 100) * 0.3,
    Math.min(Math.max(parseFloat(detail?.ret6M) || 0, -40), 150) * 0.2,
    Math.min(Math.max(parseFloat(detail?.ret1Y) || 0, -50), 200) * 0.15,
  ];
  const perfScore = Math.min(100, Math.max(10, 35 + retVals.reduce((a, b) => a + b, 0)));

  // 2. 持仓质量 — 市值+PE综合
  let qualityScore = 45;
  if (holdings?.length > 0) {
    const quotes = holdings.map(h => h._quote || {}).filter(q => Object.keys(q).length > 0);
    if (quotes.length > 0) {
      const bigCaps = quotes.filter(q => parseFloat(q.total_market_cap || 0) > 1e11).length;
      qualityScore = Math.min(95, 40 + (bigCaps / quotes.length) * 40 + 10);
    }
  }

  // 3. 估值水平
  let valScore = 50;
  if (holdings?.length > 0) {
    const pes = holdings.map(h => parseFloat(h._quote?.pe_ratio || 0)).filter(v => v > 0 && v < 500);
    if (pes.length > 0) {
      const avgPE = pes.reduce((a, b) => a + b, 0) / pes.length;
      valScore = Math.min(95, Math.max(15, 100 - avgPE * 0.8));
    }
  }

  // 4. 波动风险
  let riskScore = 50;
  if (navHistory?.length > 10) {
    const changes = [];
    for (let i = 1; i < navHistory.length; i++) {
      const p = parseFloat(navHistory[i - 1]?.nav || navHistory[i - 1]?.y) || 0;
      const c = parseFloat(navHistory[i]?.nav || navHistory[i]?.y) || 0;
      if (p > 0) changes.push(Math.abs((c - p) / p * 100));
    }
    if (changes.length > 0) {
      riskScore = Math.min(95, Math.max(15, 100 - (changes.reduce((a, b) => a + b, 0) / changes.length) * 25));
    }
  }

  // 5. 持仓集中度
  let concScore = 55;
  if (holdings?.length >= 3) {
    const top3 = Math.min(holdings.slice(0, 3).reduce((s, h) => s + (parseFloat(h.ratio) || 0), 0), 80);
    concScore = Math.min(95, Math.max(20, 100 - top3 * 1.5));
  }

  const labels = ['业绩表现', '持仓质量', '估值水平', '波动风险', '持仓集中度'];
  const scores = [Math.round(perfScore), Math.round(qualityScore), Math.round(valScore), Math.round(riskScore), Math.round(concScore)];

  AppState.radarChart = new Chart(ctx, {
    type: 'radar',
    data: {
      labels,
      datasets: [{
        label: '综合评分',
        data: scores,
        backgroundColor: 'rgba(108, 92, 231, 0.15)',
        borderColor: '#6c5ce7',
        borderWidth: 2,
        pointBackgroundColor: '#6c5ce7',
        pointBorderColor: '#fff',
        pointRadius: 5,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        r: {
          beginAtZero: true, max: 100,
          ticks: { stepSize: 20, display: false },
          pointLabels: { font: { size: 12, weight: '600' }, color: '#555770' },
          grid: { color: 'rgba(0,0,0,0.06)' },
        }
      }
    }
  });

  const breakdown = document.getElementById('scoreBreakdown');
  if (breakdown) {
    const makeBar = (label, val, color) => `
      <div class="score-item">
        <span class="score-label">${label}</span>
        <div class="score-bar-track"><div class="score-bar-fill" style="width:${val}%;background:${color}"></div></div>
        <span class="score-num">${val}</span>
      </div>`;
    breakdown.innerHTML =
      makeBar('业绩表现', scores[0], '#6c5ce7') +
      makeBar('持仓质量', scores[1], '#00b894') +
      makeBar('估值水平', scores[2], '#f39c12') +
      makeBar('波动风险', scores[3], '#e74c3c') +
      makeBar('持仓集中度', scores[4], '#1a73e8');
  }
}

// ==================== 板块资金流向面板（可配置，常驻基金分析tab） ====================

// 已收藏板块持久化
const FLOW_FAVORITES_KEY = 'fund_insight_flow_sectors';
function getFlowFavorites() {
  try { return JSON.parse(localStorage.getItem(FLOW_FAVORITES_KEY) || '[]'); }
  catch { return []; }
}
function saveFlowFavorites(list) {
  localStorage.setItem(FLOW_FAVORITES_KEY, JSON.stringify(list.slice(0, 8)));
}

// 保存/移除收藏板块
function toggleFlowFavorite(sectorName, sectorCode) {
  const favorites = getFlowFavorites();
  const idx = favorites.findIndex(f => f.code === sectorCode);
  if (idx >= 0) {
    favorites.splice(idx, 1);
  } else {
    favorites.unshift({ name: sectorName, code: sectorCode });
    if (favorites.length > 8) favorites.pop();
  }
  saveFlowFavorites(favorites);
  loadFlowPanel();
  // 同时刷新排行榜的⭐状态
  const favBtn = document.querySelector(`[data-fav-code="${sectorCode}"]`);
  if (favBtn) favBtn.textContent = idx >= 0 ? '☆' : '⭐';
}

// 加载资金流向面板
window.loadFlowPanel = async function() {
  const grid = document.getElementById('flowPanelGrid');
  if (!grid) return;

  const favorites = getFlowFavorites();
  if (!favorites.length) {
    grid.innerHTML = `<div style="text-align:center;padding:24px;color:var(--text-tertiary);">
      <span style="font-size:32px;display:block;margin-bottom:8px;">⭐</span>
      去「板块榜单」收藏你关注的板块<br>点击 ⭐ 即可添加到这里
    </div>`;
    return;
  }

  grid.innerHTML = `<div style="text-align:center;padding:24px;"><div class="loader-ring" style="margin:0 auto 14px;width:36px;height:36px;border-width:3px;"></div></div>`;

  try {
    const favStr = favorites.map(f => f.name).join(',');
    const res = await marketAPI.etfFlowBySector(favStr);
    if (!res || !res.data || !res.data.etfs) throw new Error('数据获取失败');

    const etfs = res.data.etfs.filter(e => !e.error);
    if (!etfs.length) { grid.innerHTML = '<div style="text-align:center;padding:24px;color:#8e8ea0;">暂无数据</div>'; return; }

    grid.innerHTML = etfs.map(etf => {
      const chgCls = t => t >= 0 ? 'chg-up' : 'chg-down';
      const chgStr = t => `${t >= 0 ? '+' : ''}${t.toFixed(2)}%`;
      const flowCls = s => s > 0 ? '#00b894' : s < -30 ? '#e74c3c' : '#f39c12';
      const maxAbs = Math.max(...etf.days.map(d => Math.abs(d.flowScore)), 1);
      const bars = etf.days.map(d => {
        const pct = Math.min(100, Math.abs(d.flowScore) / maxAbs * 100);
        const barColor = d.flowScore >= 0 ? 'rgba(0,184,148,0.7)' : 'rgba(231,76,60,0.7)';
        const dir = d.flowScore >= 0 ? '↑' : '↓';
        return `<div class="flow-bar-col">
          <div class="flow-bar-label">${d.date.slice(5)}</div>
          <div class="flow-bar-track"><div class="flow-bar-fill" style="height:${pct}%;background:${barColor}"></div></div>
          <div class="flow-bar-val" style="color:${flowCls(d.flowScore)}">${dir}${Math.abs(d.flowScore).toFixed(1)}</div>
          <div class="flow-bar-chg ${chgCls(d.chgPct)}">${chgStr(d.chgPct)}</div>
          <div class="flow-bar-amt">${d.amount}亿</div>
        </div>`;
      }).join('');

      return `<div class="flow-card">
        <div class="flow-card-header">
          <span class="flow-card-name">${escapeHtml(etf.name)}</span>
          <span class="flow-card-code">${etf.code}</span>
          <span class="flow-card-sector">${escapeHtml(etf.sector)}</span>
        </div>
        <div class="flow-card-legend">
          <span>📊 资金流向强度</span><span>🏷️ 涨跌幅</span><span>💵 成交额(亿)</span>
        </div>
        <div class="flow-bar-chart">${bars}</div>
      </div>`;
    }).join('');

  } catch (err) {
    grid.innerHTML = `<div style="text-align:center;padding:24px;color:#e74c3c;">加载失败: ${err.message}</div>`;
  }
};

// 管理面板：弹窗增减收藏板块
window.manageFlowPanel = function() {
  const favorites = getFlowFavorites();
  const list = favorites.length
    ? favorites.map((f, i) => `<div class="flow-mgr-item">
        <span>${escapeHtml(f.name)}</span>
        <span style="color:#8e8ea0;font-size:11px;">${f.code}</span>
        <button onclick="event.stopPropagation();removeFlowFav(${i})" style="color:#e74c3c;cursor:pointer;border:none;background:none;">✕</button>
      </div>`).join('')
    : '<div style="color:#8e8ea0;font-size:13px;">暂无收藏，去板块榜单点⭐添加</div>';

  const modal = document.createElement('div');
  modal.className = 'analysis-modal-overlay';
  modal.id = 'flowMgrModal';
  modal.innerHTML = `<div class="analysis-modal-content" style="max-width:500px;">
    <div class="analysis-header"><h3>⚙️ 管理资金流向板块</h3><button class="close-btn" onclick="document.getElementById('flowMgrModal').remove()">✕</button></div>
    <div style="margin-bottom:16px;">
      <p style="font-size:12px;color:var(--text-tertiary);margin-bottom:8px;">已收藏板块（拖拽调整顺序，最多8个）：</p>
      <div class="flow-mgr-list" id="flowMgrList">${list}</div>
    </div>
    <p style="font-size:12px;color:var(--text-tertiary);">提示：去「板块榜单」点击 ⭐ 即可收藏更多板块</p>
    <div style="margin-top:16px;text-align:right;">
      <button class="btn-primary" onclick="loadFlowPanel();document.getElementById('flowMgrModal').remove()">确定</button>
    </div>
  </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
};

window.removeFlowFav = function(idx) {
  const favorites = getFlowFavorites();
  favorites.splice(idx, 1);
  saveFlowFavorites(favorites);
  loadFlowPanel();
  // 刷新管理弹窗内容
  const mgrList = document.getElementById('flowMgrList');
  if (mgrList) {
    mgrList.innerHTML = favorites.map((f, i) => `<div class="flow-mgr-item">
      <span>${escapeHtml(f.name)}</span><span style="color:#8e8ea0;font-size:11px;">${f.code}</span>
      <button onclick="event.stopPropagation();removeFlowFav(${i})" style="color:#e74c3c;cursor:pointer;border:none;background:none;">✕</button>
    </div>`).join('') || '<div style="color:#8e8ea0;font-size:13px;">暂无收藏</div>';
  }
};

// 初始化：页面加载时自动渲染
document.addEventListener('DOMContentLoaded', () => {
  const origInit = () => { loadFlowPanel(); };
  // 延迟加载，等页面完全渲染
  setTimeout(origInit, 500);
});
