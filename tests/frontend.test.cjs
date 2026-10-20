const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
let server, browser, base;
const video = (bvid, extra = {}) => ({ bvid, avid: `av${bvid.slice(2)}`, title: `视频 ${bvid}`, uploader: '测试UP', desc: '简介', tags: [], ranks: ['domestic'], is_examined: false, is_republish: false, staff_info: '原Staff', cover: '', ...extra });
const videos = [video('BV1'), video('BV2', { is_republish: true }), video('BV3', { ranks: ['sv'] })];
const entry = (bvid, rank, specialRank = 'normal') => ({ ...video(bvid), rank, specialRank, view: 101, like: 102, share: 103, coin: 104, favorite: 105, reply: 106, danmaku: 107, isNew: true, totalScore: 500 });
const entries = [entry('BV1', 1), entry('BV2', 2)];
const specials = [{...entry('BV8',0),special_rank:'hot'},{...entry('BV9',0),special_rank:'sh'}];
before(async () => {
    server = http.createServer(async (req, res) => {
        try {
            const pathname = new URL(req.url, 'http://localhost').pathname;
            const file = path.join(root, pathname === '/' ? 'index.html' : pathname);
            if (!file.startsWith(root + path.sep)) throw Error('Invalid path');
            res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
            res.end(await fs.readFile(file));
        } catch { res.writeHead(404); res.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
});
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });
async function pageFor(t, { delay = {}, width = 1400, previewTotal = entries.length, colorScheme = "light" } = {}) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme });
    t.after(() => context.close());
    const page = await context.newPage();
    const requests = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url());
        if (url.origin !== base) return route.abort(); // Never contact production or third parties.
        if (url.pathname === '/static/wasm/cvse_wasm_client.js') return route.fulfill({ contentType: 'text/javascript', body: `
            export default async function init() {}
            export async function request(method, params, auth) {
                const routes = { getVideos: '/api/videos', getVideo: '/api/video/' + params.bvid,
                    getRankingPreview: '/api/ranking-preview', submitChanges: '/api/submit-changes',
                    calculateRankings: '/api/calculate-rankings' };
                const query = ['getVideos', 'getRankingPreview'].includes(method) ? '?' + new URLSearchParams(params) : '';
                const write = ['submitChanges', 'calculateRankings'].includes(method);
                const response = await fetch(routes[method] + query, write ? { method: 'POST', body: JSON.stringify(params) } : {});
                const result = await response.json();
                if (!response.ok || result.success === false) throw new Error('HTTP ' + response.status + ' ' + (result.error || 'Request failed'));
                return result;
            }
        ` });
        if (!url.pathname.startsWith('/api/')) return route.continue();
        requests.push({ url, method: req.method(), body: req.postDataJSON() });
        let data;
        if (url.pathname === '/api/videos') {
            const republish = url.searchParams.get('is_republish');
            let filtered = videos.filter(v => !['true', 'false'].includes(republish) || v.is_republish === (republish === 'true'));
            data = { success: true, data: filtered, total: filtered.length, stats: {} };
        } else if (url.pathname.startsWith('/api/video/')) {
            const bvid = url.pathname.split('/').pop();
            if (delay[bvid]) await new Promise(resolve => setTimeout(resolve, delay[bvid]));
            data = { success: true, data: video(bvid) };
        } else if (url.pathname === '/api/ranking-preview') {
            data = { success: true, data: { stat: { count: previewTotal }, entries: url.searchParams.has('video_id') ? entries.slice(0,1) : entries, search_id: url.searchParams.get('video_id') || '', special_entries: url.searchParams.get('include_special') === 'true' ? specials : [], total: previewTotal, has_next: true, next_cursor: {rank:21,offset:0} } };
        } else if (url.pathname === '/api/submit-changes') data = { success: true };
        else return route.abort();
        await route.fulfill({ json: data });
    });
    await page.goto(base);
    await page.waitForSelector('.video-item');
    t.after(() => assert.deepEqual(errors, []));
    return { page, requests };
}
const open = (page, bvid = 'BV1') => page.locator(`#videoList [data-bvid="${bvid}"] button`).filter({ hasText: '编辑' }).click();
const state = page => page.evaluate(() => ({ videos: app.videos, changes: [...app.changes], editing: app.currentEditingBvid }));

test('outside click cancels independent rank draft and staff edits', async t => {
    const { page, requests } = await pageFor(t);
    await open(page);
    await page.locator('#rank-domestic input').uncheck();
    await page.locator('#staffInfo').fill('不应保存');
    await page.locator('.app-header h1').click();
    assert.equal(await page.locator('#editPanel').count(), 0);
    const result = await state(page);
    assert.deepEqual(result.videos[0].ranks, ['domestic']);
    assert.equal(result.videos[0].staff_info, '原Staff');
    assert.equal(result.changes.length, 0);
    assert.equal(requests.filter(r => r.method === 'POST').length, 0);
});

test('new edit and repeated edit leave exactly one panel, cancelling prior draft', async t => {
    const { page } = await pageFor(t);
    await open(page);
    await page.locator('#rank-sv input').check();
    await open(page, 'BV3');
    assert.equal(await page.locator('#editPanel').count(), 1);
    assert.equal((await state(page)).editing, 'BV3');
    await open(page, 'BV3');
    assert.equal(await page.locator('#editPanel').count(), 1);
    assert.deepEqual((await state(page)).videos[0].ranks, ['domestic']);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#editPanel').count(), 0);
});

test('cancel preserves already staged change and clearing restores original ranks', async t => {
    const { page } = await pageFor(t);
    await open(page);
    await page.locator('#rank-sv input').check();
    await page.locator('#editPanel').getByText('保存到本地', { exact: true }).click();
    await open(page);
    await page.locator('#rank-domestic input').uncheck();
    await page.locator('#editPanel').getByText('取消', { exact: true }).click();
    assert.deepEqual((await state(page)).changes[0][1].ranks, ['domestic', 'sv']);
    await page.locator('#clearChangesBtn').click();
    assert.deepEqual((await state(page)).videos[0].ranks, ['domestic']);
});

test('batch rejection stages selected videos only, keeps metadata, and is reversible', async t => {
    const { page, requests } = await pageFor(t);
    assert.equal(await page.locator('#batchRejectBtn').isDisabled(), true);
    await page.locator('#videoList [data-bvid="BV1"] input').check();
    await page.locator('#videoList [data-bvid="BV2"] input').check();
    await page.locator('#batchRejectBtn').click();
    const result = await state(page);
    assert.equal(result.changes.length, 2);
    for (const [, change] of result.changes) { assert.deepEqual(change.ranks, []); assert.equal(change.is_examined, true); assert.equal(change.staff_info, '原Staff'); }
    assert.equal(result.changes[1][1].is_republish, true);
    assert.equal(result.videos[2].is_examined, false);
    assert.equal(requests.filter(r => r.method === 'POST').length, 0);
    assert.equal(await page.locator('#batchRejectBtn').isDisabled(), true);
    await page.locator('#clearChangesBtn').click();
    assert.deepEqual((await state(page)).videos, videos);
});

test('recording has red batch exclusion; preview keeps neutral single and editor exclusion', async t => {
    const { page } = await pageFor(t);
    assert.equal(await page.locator('#videoList button').filter({hasText:'收录排除'}).count(),0);
    assert.equal(await page.locator('#batchRejectBtn .desktop-label').textContent(),'批量排除');
    assert.match(await page.locator('#batchRejectBtn').getAttribute('class'),/btn-danger/);
    await open(page);assert.equal(await page.locator('#editPanel').getByText('收录排除',{exact:true}).count(),0);
    await page.keyboard.press('Escape');
    await page.locator('[data-page="preview"]').click();await page.locator('#getPreviewBtn').click();await page.waitForSelector('.ranking-row');
    const exclude=page.locator('.ranking-row').first().getByText('收录排除',{exact:true});assert.match(await exclude.getAttribute('class'),/btn-secondary/);await exclude.click();
    assert.equal((await state(page)).changes.length,1);
    await page.locator('.ranking-row').nth(1).getByText('编辑',{exact:false}).click();
    await page.locator('#staffInfo').fill('新Staff');
    await page.locator('#editPanel').getByText('收录排除',{exact:true}).click();
    const change=(await state(page)).changes.find(([bvid])=>bvid==='BV2')[1];assert.deepEqual(change.ranks,[]);assert.equal(change.is_examined,true);assert.equal(change.staff_info,'新Staff');
});

test('republish filter reaches API and includes both true and false modes', async t => {
    const { page, requests } = await pageFor(t);
    for (const [value, count] of [['true', 1], ['false', 2], ['', 3]]) {
        await page.locator('#republishFilter').selectOption(value);
        await page.locator('#searchBtn').click();
        await page.waitForFunction(count => document.querySelectorAll('#videoList .video-item').length === count, count);
        assert.equal(requests.at(-1).url.searchParams.get('is_republish'), value);
    }
});

test('preview horizontal rows show seven metrics, new submission label, and optional HOT/SH', async t => {
    const { page, requests } = await pageFor(t);
    await page.locator('[data-page="preview"]').click();
    assert.equal(await page.locator('#previewShowSpecial').isChecked(), false);
    await page.locator('#getPreviewBtn').click();
    await page.waitForSelector('.ranking-row');
    assert.equal(await page.locator('.ranking-row').count(), 2);
    for (const label of ['播放', '点赞', '分享', '硬币', '收藏', '评论', '弹幕']) assert.equal(await page.locator('.ranking-row').first().getByText(label, { exact: true }).count(), 1);
    assert.equal(await page.getByText('新上榜', { exact: true }).count(), 0);
    assert.equal(await page.locator('.ranking-row').first().getByText('新投稿', { exact: true }).count(), 1);
    const boxes = await page.locator('.ranking-row').evaluateAll(rows => rows.map(row => { const r = row.getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width }; }));
    assert.equal(boxes[0].x, boxes[1].x); assert.ok(boxes[1].y > boxes[0].y); assert.ok(boxes[0].width > 800);
    const previewRequestCount = requests.filter(r => r.url.pathname === '/api/ranking-preview').length;
    await page.locator('#previewShowSpecial').check();
    await page.waitForFunction(() => document.querySelectorAll('.ranking-row').length === 4);
    assert.equal(requests.filter(r => r.url.pathname === '/api/ranking-preview').length, previewRequestCount);
    assert.equal(await page.locator('.ranking-rank').getByText('HOT', { exact: true }).count(), 1);
    assert.equal(await page.locator('.ranking-rank').getByText('SH', { exact: true }).count(), 1);
});

test('late preview edit response cannot override newer edit or reopen after cancel', async t => {
    const { page } = await pageFor(t, { delay: { BV8: 350, BV9: 350 } });
    await page.evaluate(() => { app.openEditPanelByBvid('BV8'); app.openEditPanel('BV1'); });
    await page.waitForTimeout(450);
    assert.equal((await state(page)).editing, 'BV1');
    await page.evaluate(() => { app.openEditPanelByBvid('BV9'); app.closeEditPanel(); });
    await page.waitForTimeout(450);
    assert.equal(await page.locator('#editPanel').count(), 0);
});

test('navigation cancels editing without losing saved work', async t => {
    const { page } = await pageFor(t);
    await open(page);
    await page.locator('#rank-sv input').check();
    await page.locator('[data-page="preview"]').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#editPanel').count(), 0);
    assert.deepEqual((await state(page)).videos[0].ranks, ['domestic']);
});

test('mobile preview fits viewport and actions remain reachable', async t => {
    const { page } = await pageFor(t, { width: 390 });
    await page.locator('[data-page="preview"]').click();
    await page.locator('#getPreviewBtn').click();
    await page.waitForSelector('.ranking-row');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(overflow, false);
    await page.locator('.ranking-row').first().getByText('编辑', { exact: false }).click();
    assert.equal(await page.locator('#editPanel').count(), 1);
});

test('new filters, logo, large page size, exact search and exclusion work in browser', async t => {
    const { page, requests } = await pageFor(t);
    await page.locator('#rankFilter summary').click();
    await page.locator('#rankFilter input[value="sv"]').check();
    await page.locator('#rankFilter input[value="utau"]').check();
    const before = requests.length;
    await page.locator('#searchBtn').click();
    await page.waitForFunction(() => !document.querySelector('#videoList .loading'));
    assert.equal(requests.length, before + 1);
    assert.equal(requests.at(-1).url.searchParams.get('rank'), 'sv,utau');
    assert.equal(await page.locator('.logo-icon').evaluate(img => img.complete && img.naturalWidth > 0), true);
    await page.locator('[data-page="preview"]').click();
    const previewRequestsBefore = requests.filter(r => r.url.pathname === '/api/ranking-preview').length;
    await page.locator('#previewPageSize').selectOption('120');
    assert.equal(requests.filter(r => r.url.pathname === '/api/ranking-preview').length, previewRequestsBefore);
    assert.match(await page.locator('#rankingPreview').textContent(), /请点击“预览”/);
    await page.locator('#getPreviewBtn').click();
    await page.waitForSelector('.ranking-row');
    assert.equal(requests.at(-1).url.searchParams.get('page_size'), '120');
    await page.locator('.ranking-row').first().getByText('收录排除', {exact:true}).click();
    await page.waitForSelector('.ranking-excluded');
    assert.match(await page.locator('.ranking-excluded').first().textContent(), /待提交/);
    await page.locator('#clearChangesBtn').click();
    assert.equal(await page.locator('.ranking-excluded').count(), 0);
    await page.locator('#previewVideoId').fill('av123');
    await page.locator('#previewVideoId').press('Enter');
    await page.waitForSelector('.ranking-row');
    assert.equal(requests.at(-1).url.searchParams.get('video_id'), 'av123');
    assert.equal(requests.at(-1).url.searchParams.has('include_special'), false);
    await page.screenshot({path:'/tmp/cvse-preview-desktop.png', fullPage:true});
});

test('both preview pagers stay synchronized and mobile expanded filter fits viewport', async t => {
    const { page, requests } = await pageFor(t, {width:390,previewTotal:4100});
    await page.locator('#toggleRecordingFilters').click();
    await page.locator('#rankFilter summary').click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.locator('[data-page="preview"]').click();
    await page.locator('#getPreviewBtn').click();
    await page.waitForSelector('.ranking-row');
    assert.equal(await page.locator('#previewPageInputTop').count(), 0);
    await page.locator('#previewNextPageBtnTop').click();
    await page.waitForFunction(() => app.previewPage===2);
    assert.equal(requests.at(-1).url.searchParams.get('page'), '2');
    assert.match(await page.locator('#previewPageInfo').textContent(), /第 2 页/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({path:'/tmp/cvse-preview-mobile.png', fullPage:true});
});

test('preview pagers recover from a failed next page and can keep moving in both directions', async t => {
    const { page } = await pageFor(t);
    const calls = []; let fail = true;
    await page.route('**/api/ranking-preview?*', async route => {
        const query = new URL(route.request().url()).searchParams;
        const number = Number(query.get('page'));
        calls.push({ page: number, rank: query.get('cursor_rank'), offset: query.get('cursor_offset') });
        if (number === 2 && fail) {
            fail = false;
            return route.fulfill({ status: 503, json: { success: false, error: 'Backend is busy' } });
        }
        await route.fulfill({ json: { success: true, data: {
            entries: [entry(`BV${number}`, number * 20)], stat: { count: 60 }, total: 60,
            has_next: number < 3, next_cursor: number < 3 ? { rank: number * 20, offset: 1 } : null,
        } } });
    });
    await page.locator('[data-page="preview"]').click();
    await page.locator('#getPreviewBtn').click();
    await page.waitForSelector('.ranking-row');
    await page.locator('#previewNextPageBtnTop').click();
    await page.waitForSelector('#rankingPreview [role="status"]');
    assert.deepEqual(calls.map(call => call.page), [1, 2]);
    assert.equal(await page.locator('.ranking-row .ranking-rank').textContent(), '#20');
    for (const suffix of ['', 'Top']) {
        assert.equal(await page.locator(`#previewNextPageBtn${suffix}`).isEnabled(), true);
        assert.equal(await page.locator(`#previewPrevPageBtn${suffix}`).isDisabled(), true);
        assert.match(await page.locator(`#previewPageInfo${suffix}`).textContent(), /第 1 页/);
    }
    await page.locator('#previewNextPageBtn').click();
    await page.waitForFunction(() => app.previewPage === 2 && !app.previewLoading);
    assert.equal(await page.locator('.ranking-row .ranking-rank').textContent(), '#40');
    assert.equal(await page.locator('#rankingPreview [role="status"]').count(), 0);
    assert.deepEqual(calls[2], { page: 2, rank: '20', offset: '1' });
    await page.locator('#previewNextPageBtnTop').click();
    await page.waitForFunction(() => app.previewPage === 3 && !app.previewLoading);
    assert.equal(await page.locator('.ranking-row .ranking-rank').textContent(), '#60');
    for (const suffix of ['', 'Top']) {
        assert.equal(await page.locator(`#previewNextPageBtn${suffix}`).isDisabled(), true);
        assert.equal(await page.locator(`#previewPrevPageBtn${suffix}`).isEnabled(), true);
    }
    await page.locator('#previewPrevPageBtn').click();
    await page.waitForFunction(() => app.previewPage === 2 && !app.previewLoading);
    await page.locator('#previewPrevPageBtnTop').click();
    await page.waitForFunction(() => app.previewPage === 1 && !app.previewLoading);
    assert.equal(await page.locator('.ranking-row .ranking-rank').textContent(), '#20');
    assert.deepEqual(calls.map(call => call.page), [1, 2, 2, 3, 2, 1]);
});

test('old deployed server reports version mismatch instead of silently disabling pagination',async t=>{
 const {page}=await pageFor(t);let calls=0;
 await page.route('**/api/ranking-preview?*',async route=>{
  calls++;const size=new URL(route.request().url()).searchParams.get('page_size');
  if(size==='120') return route.fulfill({status:400,json:{success:false,error:'page must be >= 1 and page_size must be between 1 and 110'}});
  return route.fulfill({json:{success:true,data:{entries:[entry('BV1',1)],stat:{count:80153},total:80153,page:1,page_size:20}}});
 });
 await page.locator('[data-page="preview"]').click();
 for(const size of ['120','20']){
  const before=calls;await page.locator('#previewPageSize').selectOption(size);
  assert.equal(calls,before);assert.match(await page.locator('#rankingPreview').textContent(),/请点击“预览”/);
  await page.locator('#getPreviewBtn').click();await page.waitForSelector('#rankingPreview [role="status"]');
  assert.equal(calls,before+1);assert.match(await page.locator('#rankingPreview [role="status"]').textContent(),/请联系管理员更新并重启服务/);
  assert.equal(await page.locator('.ranking-row').count(),0);assert.equal(await page.locator('#getPreviewBtn').isEnabled(),true);
  assert.equal(await page.locator('#previewPaginationTop').isVisible(),false);
 }
});


test('theme follows system by default, switches without RPC, and persists manual choice',async t=>{
 const {page,requests}=await pageFor(t,{colorScheme:'dark'});
 assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
 assert.equal(await page.locator('#themeSelect').inputValue(),'system');
 assert.equal(await page.locator('body').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(13, 20, 34)');
 const before=requests.length;
 await page.emulateMedia({colorScheme:'light'});
 await page.waitForFunction(()=>document.documentElement.dataset.theme==='light');
 await page.locator('#themeSelect').selectOption('dark');
 assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');assert.equal(requests.length,before);
 await page.reload();await page.waitForSelector('.video-item');
 assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');assert.equal(await page.locator('#themeSelect').inputValue(),'dark');
 await open(page);
 assert.equal(await page.locator('#editPanel').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(23, 33, 50)');
 await page.screenshot({path:'/tmp/cvse-dark-editor.png',fullPage:true,animations:'disabled'});
 await page.keyboard.press('Escape');
 await page.locator('#settingsBtn').click();
 assert.equal(await page.locator('#settingsModal').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(23, 33, 50)');
 await page.locator('#settingsModalClose').click();
 await page.locator('#themeSelect').selectOption('system');
 assert.equal(await page.locator('html').getAttribute('data-theme'),'light');
 await page.emulateMedia({colorScheme:'dark'});await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
 await page.screenshot({path:'/tmp/cvse-dark-recording.png',fullPage:true});
});

test('dark preview and mobile controls remain readable and fit viewport',async t=>{
 const {page}=await pageFor(t,{width:390,colorScheme:'dark'});
 await page.locator('#themeSelect').scrollIntoViewIfNeeded();
 assert.equal(await page.locator('#themeSelect').isVisible(),true);
 await page.locator('[data-page="preview"]').click();await page.locator('#getPreviewBtn').click();await page.waitForSelector('.ranking-row');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.screenshot({path:'/tmp/cvse-dark-mobile.png',fullPage:true});
});


for (const [width,colorScheme] of [[320,'dark'],[390,'light'],[430,'dark']]) {
 test(`mobile layout ${width}px has reachable controls, collapsible filters and bounded editor`,async t=>{
  const {page,requests}=await pageFor(t,{width,colorScheme});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  for(const selector of ['#settingsBtn','#themeSelect','[data-page="debug"]']){
   const rect=await page.locator(selector).boundingBox();assert.ok(rect.x>=0&&rect.x+rect.width<=width);
  }
  assert.equal(await page.locator('#recordingFilters').isVisible(),false);
  const before=requests.length;
  await page.locator('#toggleRecordingFilters').click();assert.equal(await page.locator('#recordingFilters').isVisible(),true);
  assert.equal(await page.locator('#toggleRecordingFilters').getAttribute('aria-expanded'),'true');
  await page.locator('#rankFilter summary').click();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.locator('#rankFilter input[value="sv"]').check();
  await page.locator('#toggleRecordingFilters').click();assert.equal(requests.length,before);
  await page.locator('#toggleRecordingFilters').click();assert.equal(await page.locator('#rankFilter input[value="sv"]').isChecked(),true);
  await page.locator('#clearRecordingFiltersBtn').click();await page.waitForFunction(()=>!document.querySelector('#videoList .loading'));
  await page.locator('#toggleRecordingFilters').click();
  const pager=await page.locator('#pagination').boundingBox();assert.ok(pager.x+pager.width<=width);
  await page.screenshot({path:`/tmp/cvse-mobile-${width}.png`,fullPage:true,animations:'disabled'});
  await open(page);await page.setViewportSize({width,height:440});
  await page.locator('#staffInfo').fill('手机修改');
  const save=page.locator('#editPanel').getByText('保存到本地',{exact:true});
  const box=await save.boundingBox();assert.ok(box.y>=0&&box.y+box.height<=440);
  assert.equal(await page.locator('#staffInfo').evaluate(el=>getComputedStyle(el).fontSize),'16px');
  await page.screenshot({path:`/tmp/cvse-mobile-editor-${width}.png`,fullPage:true,animations:'disabled'});
  await save.click();assert.equal(await page.locator('#editPanel').count(),0);
  assert.equal((await state(page)).changes[0][1].staff_info,'手机修改');
 });
}

for (const width of [320, 390]) {
 test(`mobile batch bar stays visible while scrolling at ${width}px`, async t => {
  const {page, requests} = await pageFor(t, {width});
  await page.setViewportSize({width, height: 640});
  await page.locator('#selectionMore summary').click();
  await page.locator('#selectVisibleBtn').click();
  const before = requests.length;
  await page.evaluate(() => {
   const bar = document.querySelector('#selectionBar');
   window.scrollTo(0, bar.getBoundingClientRect().top + scrollY + 160);
  });
  await page.waitForFunction(() => Math.abs(document.querySelector('#selectionBar').getBoundingClientRect().top) < 1);
  for (const selector of ['#batchMarkExaminedBtn', '#batchRejectBtn']) {
   const box = await page.locator(selector).boundingBox();
   assert.ok(box.y >= 0 && box.y + box.height <= 640);
   assert.ok(box.x >= 0 && box.x + box.width <= width);
  }
  await page.locator('#selectionMore summary').click();
  await page.locator('#clearSelectionBtn').click();
  assert.equal(await page.locator('#selectionBar').evaluate(el => el.classList.contains('has-selection')), false);
  assert.equal(requests.length, before);
 });
}

for (const width of [320, 390]) {
 test(`mobile compact changes drawer at ${width}px preserves drafts and avoids obstruction`, async t => {
  const {page, requests} = await pageFor(t, {width});
  await page.setViewportSize({width, height: 700});
  await open(page);
  await page.locator('#staffInfo').fill('drawer test');
  await page.locator('#editPanel').getByText('保存到本地', {exact:true}).click();
  assert.equal(await page.locator('#changesList').isVisible(), false);
  const bar = await page.locator('#changesPanel').boundingBox();
  assert.ok(bar.height <= 65);
  await page.locator('#toggleChangesBtn').click();
  assert.equal(await page.locator('#changesList').isVisible(), true);
  assert.ok((await page.locator('#changesPanel').boundingBox()).height <= 420);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.locator('#changesBackdrop').click({position:{x:10,y:10}});
  assert.equal(await page.locator('#changesList').isVisible(), false);
  assert.equal((await state(page)).changes.length, 1);
  await open(page);
  assert.equal(await page.locator('#changesPanel').isVisible(), false);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#changesPanel').isVisible(), true);
  await page.locator('#submitChangesBtn').click();
  assert.equal(await page.locator('#submitModal').isVisible(), true);
  await page.locator('#modalCancel').click();
  assert.equal(requests.filter(r => r.method === 'POST').length, 0);
  await page.screenshot({path:`/tmp/cvse-compact-${width}.png`,fullPage:true});
 });
}
