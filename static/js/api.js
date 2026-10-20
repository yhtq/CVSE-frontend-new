import { getAuthHeaders } from './utils.js';

let wasmClient;

async function rpcRequest(method, params, auth = getAuthHeaders()['X-Auth-Key'] || null) {
    // Only initialization is shared; each request() opens its own WebSocket session.
    wasmClient ||= import('/static/wasm/cvse_wasm_client.js').then(async module => {
        await module.default();
        return module.request;
    }).catch(error => {
        wasmClient = null;
        throw error;
    });
    const request = await wasmClient;
    try {
        return await request(method, params, auth);
    } catch (error) {
        // wasm-bindgen rejects with a JS string rather than an Error.
        throw typeof error === 'string' ? new Error(error) : error;
    }
}

export async function validateAuthKey(authKey) {
    // Read-only RPCs do not authenticate; even a successful read cannot verify this key.
    return { success: true, valid: false, message: '只读 RPC 无法验证 API Key 权限；需服务端验证或经授权的写入才能确认。' };
}

const pendingVideoRequests = new Map();
export function getVideos(params) {
    const query = new URLSearchParams(params);
    const auth = getAuthHeaders()['X-Auth-Key'] || null;
    const key = JSON.stringify([query.toString(), auth]);
    if (pendingVideoRequests.has(key)) return pendingVideoRequests.get(key);
    const promise = (async () => {
        try {
            return await rpcRequest('getVideos', {
                ...Object.fromEntries(query),
                page: Number(query.get('page') || 1),
                page_size: Number(query.get('page_size') || 20),
            }, auth);
        } finally { pendingVideoRequests.delete(key); }
    })();
    pendingVideoRequests.set(key, promise);
    return promise;
}

export async function getVideo(bvid) {
    return rpcRequest('getVideo', { bvid });
}

export async function submitChanges(changes) {
    const result = await rpcRequest('submitChanges', { changes });
    previewSpecialCache.clear();
    return result;
}

export async function calculateRankings({ rank, index, containUnexamined = true, lock = false }) {
    const result = await rpcRequest('calculateRankings', {
        rank,
        index,
        contain_unexamined: containUnexamined,
        lock,
    });
    previewSpecialCache.clear();
    return result;
}

let pendingPreview = null;
const previewSpecialCache = new Map();

export function cancelRankingPreview() {
    if (pendingPreview) {
        pendingPreview.controller.abort();
        pendingPreview = null;
    }
}

export function getRankingPreview({ rank, index, page, pageSize, videoId = '', cursor }) {
    const query = new URLSearchParams({ rank, index, page, page_size: pageSize });
    if (videoId) query.set('video_id', videoId);
    if (cursor) { query.set('cursor_rank', cursor.rank); query.set('cursor_offset', cursor.offset); }
    const key = query.toString();
    if (pendingPreview?.key === key) return pendingPreview.promise;
    cancelRankingPreview();
    const specialKey = JSON.stringify([rank, index]);
    const cachedSpecial = previewSpecialCache.get(specialKey);
    if (!cachedSpecial && !videoId) query.set('include_special', 'true');
    const controller = new AbortController();
    const current = { key, controller, promise: null };
    pendingPreview = current;
    current.promise = (async () => {
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 40000);
        try {
            // WASM cannot close an in-flight RPC; reject locally and ignore its late result.
            const result = await new Promise((resolve, reject) => {
                const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
                controller.signal.addEventListener('abort', onAbort, { once: true });
                rpcRequest('getRankingPreview', {
                    ...Object.fromEntries(query),
                    index: Number(index), page: Number(page), page_size: Number(pageSize),
                    ...(cursor ? { cursor_rank: Number(cursor.rank), cursor_offset: Number(cursor.offset) } : {}),
                    ...(query.has('include_special') ? { include_special: true } : {}),
                }).then(
                    value => { controller.signal.removeEventListener('abort', onAbort); resolve(value); },
                    error => { controller.signal.removeEventListener('abort', onAbort); reject(error); }
                );
            });
            if (!videoId) {
                const data = result?.data;
                const cursor = data?.next_cursor;
                if (typeof data?.has_next !== 'boolean' || (data.has_next && (
                    !Number.isInteger(cursor?.rank) || cursor.rank < 1 || cursor.rank > 2147483646 ||
                    !Number.isInteger(cursor?.offset) || cursor.offset < 0 || cursor.offset > 200000
                ))) {
                    throw new Error('预览服务版本与页面不一致：响应缺少有效的分页信息，请更新并重启服务。');
                }
            }
            if (!controller.signal.aborted && result?.data && !videoId) {
                const special = cachedSpecial || { entries: result.data.special_entries || [], truncated: result.data.special_truncated || false };
                if (!cachedSpecial) {
                    if (previewSpecialCache.size >= 8) previewSpecialCache.delete(previewSpecialCache.keys().next().value);
                    previewSpecialCache.set(specialKey, special);
                }
                result.data.special_entries = special.entries;
                result.data.special_truncated = special.truncated;
            }
            return result;
        } catch (error) {
            if (timedOut) throw new Error('预览读取超时，请稍后手动重试');
            throw error;
        } finally {
            clearTimeout(timer);
            if (pendingPreview === current) pendingPreview = null;
        }
    })();
    return current.promise;
}

export async function sendDebugRequest(endpoint, paramsStr) {
    const methods = {
        '/api/videos': 'getVideos',
        '/api/video/BVxxx': 'getVideo',
        '/api/ranking-preview': 'getRankingPreview',
        '/api/submit-changes': 'submitChanges',
        '/api/calculate-rankings': 'calculateRankings',
    };
    const method = methods[endpoint];
    if (!method) throw new Error(`不支持的 RPC 调试端点: ${endpoint}`);
    const params = method === 'getVideo' ? { bvid: 'BVxxxxxx' } : (paramsStr ? JSON.parse(paramsStr) : {});
    const startTime = performance.now();
    const result = await rpcRequest(method, params);
    return { status: 200, duration: (performance.now() - startTime).toFixed(0), result };
}
