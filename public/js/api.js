/**
 * Fund Insight Pro - API Client
 * 统一 API 请求封装，错误处理，缓存策略
 */

const API_BASE = ''; // 同源部署

/**
 * 通用 API 请求方法
 */
async function api(path, options = {}) {
  const url = `${API_BASE}${path}`;
  try {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json', ...options.headers },
      ...options,
    });
    const data = await res.json();
    if (data.code !== 0 && data.code !== undefined) {
      console.warn(`[API Warning] ${path}:`, data.message);
    }
    return data;
  } catch (err) {
    console.error(`[API Error] ${path}:`, err);
    throw err;
  }
}

/**
 * 带缓存的 API 请求
 */
const apiCache = new Map();

function cacheKey(path, params) {
  return path + JSON.stringify(params || {});
}

async function apiCached(path, ttlMs = 60000) {
  const key = cacheKey(path);
  const cached = apiCache.get(key);
  if (cached && Date.now() - cached.ts < ttlMs) {
    return cached.data;
  }
  const data = await api(path);
  apiCache.set(key, { data, ts: Date.now() });
  // 清理过期缓存（简单策略）
  if (apiCache.size > 200) {
    for (const [k, v] of apiCache) {
      if (Date.now() - v.ts > ttlMs * 2) apiCache.delete(k);
    }
  }
  return data;
}

// ==================== Fund APIs ====================
const fundAPI = {
  search: (q) => api(`/api/fund/search?q=${encodeURIComponent(q)}`),
  detail: (code) => api(`/api/fund/etf/${code}`),
  holdings: (code) => apiCached(`/api/fund/holdings/${code}`, 120000),
  nav: (code, start, end) => {
    let url = `/api/fund/nav/${code}`;
    if (start) url += `?start=${start}`;
    if (end) url += end ? `&end=${end}` : '';
    return apiCached(url, 180000);
  },
  kline: (code, period = 'day', limit = 120) =>
    apiCached(`/api/stock/kline/${code}?period=${period}&limit=${limit}`, 180000),

  // 代码类型检测
  detect: (code) => api(`/api/fund/detect/${code}`),

  // =========== 场外基金 ===========
  fundRealtime: (code) => api(`/api/fund/regular/realtime/${code}`),
  fundDetail: (code) => api(`/api/fund/regular/detail/${code}`),
  fundNavHistory: (code, limit = 120) => api(`/api/fund/regular/nav/${code}?limit=${limit}`),
  fundHoldings: (code) => api(`/api/fund/regular/holdings/${code}`),
  fundAnalysis: (code) => api(`/api/fund/regular/analysis/${code}`),
  fundHoldingsEnriched: (code) => api(`/api/fund/regular/holdings-enriched/${code}`),
  // 板块场外基金涨幅榜
  sectorTop: (sectorName, topN = 10) => api(`/api/fund/regular/sector-top/${encodeURIComponent(sectorName)}?top=${topN}`),
  // 潜力基金筛选
  screener: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return api(`/api/fund/screener?${qs}`);
  },
};

// ==================== Stock APIs ====================
const stockAPI = {
  profile: (code) => apiCached(`/api/stock/profile/${code}`, 300000),
  quote: (codes) => apiCached(`/api/stock/quote/${codes}`, 30000), // 行情30秒缓存
  finance: (code, num = 4, type) => {
    let url = `/api/stock/finance/${code}?num=${num}`;
    if (type) url += `&type=${type}`;
    return apiCached(url, 3600000); // 财务数据1小时缓存
  },
  technical: (code, group = 'all') =>
    apiCached(`/api/stock/technical/${code}?group=${group}`, 60000),
  fundFlow: (code) => apiCached(`/api/stock/fund/${code}`, 60000),
  rating: (code) => apiCached(`/api/stock/rating/${code}`, 86400000),
  consensus: (code) => apiCached(`/api/stock/consensus/${code}`, 86400000),
  risk: (code, types) => {
    let url = `/api/stock/risk/${code}`;
    if (types) url += `?types=${types}`;
    return api(url);
  },
};

// ==================== Sector APIs ====================
const sectorAPI = {
  rank: (rankType, sort) =>
    apiCached(`/api/sector/rank?rankType=${rankType || 'interval_chg_rank_sw1'}&sort=${sort || ''}`, 60000),
  components: (code) => apiCached(`/api/sector/${code}`, 180000),
  search: (keyword) => api(`/api/sector/search/${encodeURIComponent(keyword)}`),
  analyze: (code) => api(`/api/sector/analyze/${code}`),
  // 获取板块名称列表（用于下拉框）
  sectorNames: () => apiCached(`/api/sector/rank?rankType=interval_chg_rank_sw1&sort=chg5Days`, 120000),
  // 含日涨跌的排行
  rankWithDaily: () => apiCached('/api/sector/rank-with-daily', 60000),
};

// ==================== Hot / Market APIs ====================
const marketAPI = {
  hotSectors: (limit = 10) => apiCached(`/api/hot/sectors?limit=${limit}`, 120000),
  hotEtf: () => apiCached(`/api/hot/etf`, 120000),
  // 行业ETF资金流向
  etfFlow: (codes, days = 5) => {
    const params = new URLSearchParams({ days });
    if (codes) params.set('codes', codes);
    return apiCached(`/api/etf/flow?${params}`, 120000);
  },
  // 按板块名称获取对应ETF资金流向
  etfFlowBySector: (sectorNames) => api(`/api/etf/flow/sector?sectors=${encodeURIComponent(sectorNames)}`),
};
