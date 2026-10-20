const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const video = (bvid, extra = {}) => ({ bvid, avid: `av${bvid.slice(2)}`, title: `视频 ${bvid}`, uploader: 'UP', desc: '简介', tags: [], ranks: ['domestic'], is_examined: false, is_republish: false, staff_info: '原Staff', cover: '', ...extra });
const initial = [video('BV1'), video('BV2', { is_republish: true }), video('BV3', { ranks: ['sv'] })];
const clean = value => JSON.parse(JSON.stringify(value));
async function setup(t) {
    const dom = new JSDOM(fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, ''), { url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true });
    const w=dom.window, requests=[]; let pending = new Map();
    w.scrollTo=()=>{}; w.alert=()=>{}; w.confirm=()=>true;
    w.fetch = async (url, options={}) => {
        requests.push({url, options});
        if (url.startsWith('/api/video/')) {
            const bvid=url.split('/').pop();
            if(pending.has(bvid)) return pending.get(bvid);
            return {ok:true,json:async()=>({success:true,data:video(bvid)})};
        }
        if (url.startsWith('/api/ranking-preview')) return {ok:true,json:async()=>({success:true,data:{entries:[],stat:{count:2},total:0,has_next:false,next_cursor:null}})};
        return {ok:true,json:async()=>({success:true,data:clean(initial),total:3,stats:{}})};
    };
    w.__loadWasmClient = async () => ({ default: async () => {}, request: async (method, params, auth) => {
        if (w.__request) return w.__request(method, params, auth);
        const routes = { getVideos: '/api/videos', getVideo: `/api/video/${params.bvid}`, getRankingPreview: '/api/ranking-preview', submitChanges: '/api/submit-changes', calculateRankings: '/api/calculate-rankings' };
        const url = routes[method] + (['getVideos', 'getRankingPreview'].includes(method) ? `?${new URLSearchParams(params)}` : '');
        const options = ['submitChanges', 'calculateRankings'].includes(method) ? { method: 'POST', body: JSON.stringify(params) } : {};
        const response = await w.fetch(url, options);
        const result = await response.json();
        if (!response.ok || result.success === false) throw new Error(`HTTP ${response.status || 500} ${result.error || 'Request failed'}`);
        return result;
    } });
    for(const file of ['utils.js','api.js','renderers.js','app.js']) {
        let source=fs.readFileSync(path.join(root,'static/js',file),'utf8').replace(/^import[\s\S]*?from ['"].*?['"];\n/gm,'').replace(/^export /gm,'');
        if(file==='api.js') source=source.replace("import('/static/wasm/cvse_wasm_client.js')", 'window.__loadWasmClient()');
        if(file==='api.js') source+='\nwindow.calculateRankingsRequest=calculateRankings; window.submitChangesRequest=submitChanges; window.sendDebugRequestApi=sendDebugRequest;';
        w.eval(source);
    }
    await new Promise(resolve=>setTimeout(resolve,0));
    t.after(()=>w.close());
    return {w, app:w.app, doc:w.document, requests, defer(bvid){let resolve; const promise=new Promise(r=>resolve=r);pending.set(bvid,promise);return ()=>resolve({ok:true,json:async()=>({success:true,data:video(bvid)})});}};
}
const click=(doc,selector)=>doc.querySelector(selector).click();
function changeCheckbox(w,selector,checked){const el=w.document.querySelector(selector);el.checked=checked;el.dispatchEvent(new w.Event('change',{bubbles:true}));}

test('outside click cancels rank and staff draft without modifying original or submitting', async t=>{
 const {w,app,doc,requests}=await setup(t); app.openEditPanel('BV1');
 changeCheckbox(w,'#rank-domestic input',false);doc.querySelector('#staffInfo').value='discard';click(doc,'.card-title');
 assert.equal(doc.querySelector('#editPanel'),null);assert.deepEqual(clean(app.videos),initial);assert.equal(app.changes.size,0);assert.ok(requests.every(r=>!r.options.method||r.options.method==='GET'));
});
test('opening another or same edit keeps exactly one panel and cancels former rank draft',async t=>{
 const {w,app,doc}=await setup(t);app.openEditPanel('BV1');changeCheckbox(w,'#rank-sv input',true);app.openEditPanel('BV2');app.openEditPanel('BV2');
 assert.equal(doc.querySelectorAll('#editPanel').length,1);assert.equal(app.currentEditingBvid,'BV2');assert.deepEqual(clean(app.videos[0].ranks),['domestic']);
 doc.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(doc.querySelector('#editPanel'),null);
});
test('clicking blank inside panel does not dismiss; cancel restores original arrays', async t=>{
 const {w,app,doc}=await setup(t);app.openEditPanel('BV1');click(doc,'.edit-panel-body');assert.ok(doc.querySelector('#editPanel'));
 changeCheckbox(w,'#rank-sv input',true);app.closeEditPanel();assert.deepEqual(clean(app.videos[0].ranks),['domestic']);
});
test('cancel preserves previous saved changes and clearing restores initial ranks',async t=>{
 const {w,app,doc}=await setup(t);app.openEditPanel('BV1');changeCheckbox(w,'#rank-sv input',true);app.saveChange('BV1');
 app.openEditPanel('BV1');changeCheckbox(w,'#rank-domestic input',false);app.closeEditPanel();
 assert.deepEqual(clean(app.changes.get('BV1').ranks),['domestic','sv']);app.clearChanges();assert.deepEqual(clean(app.videos),initial);
});
test('batch rejection only stages selected items, preserving republish and staff; undo works',async t=>{
 const {app,doc,requests}=await setup(t);assert.equal(doc.querySelector('#batchRejectBtn').disabled,true);
 app.toggleVideoSelection('BV1',true);app.toggleVideoSelection('BV2',true);click(doc,'#batchRejectBtn');
 assert.equal(app.changes.size,2);for(const v of app.changes.values()){assert.deepEqual(clean(v.ranks),[]);assert.equal(v.is_examined,true);assert.equal(v.staff_info,'原Staff');}
 assert.equal(app.changes.get('BV2').is_republish,true);assert.equal(app.videos[2].is_examined,false);assert.equal(app.selectedVideos.size,0);assert.ok(requests.every(r=>!r.options.method));
 app.clearChanges();assert.deepEqual(clean(app.videos),initial);
});
test('exclusion from card or editor stages correct state and has no false included label',async t=>{
 const {app,doc}=await setup(t);await app.excludeVideo('BV1');assert.equal(app.changes.get('BV1').is_examined,true);assert.equal(doc.querySelector('[data-bvid="BV1"] .tag-examined'),null);
 app.openEditPanel('BV2');doc.querySelector('#staffInfo').value='新Staff';app.excludeEditingVideo();assert.equal(app.changes.get('BV2').staff_info,'新Staff');assert.deepEqual(clean(app.changes.get('BV2').ranks),[]);assert.equal(doc.querySelector('#editPanel'),null);
});
test('preview-only single exclusion loads video and enters same pending queue',async t=>{
 const {app,requests}=await setup(t);await app.excludeVideo('BV8');assert.equal(app.changes.get('BV8').is_examined,true);assert.deepEqual(clean(app.changes.get('BV8').ranks),[]);assert.ok(requests.every(r=>!r.options.method));
});
test('republish filter includes true/false/all in local results and server request',async t=>{
 const {app,doc,requests}=await setup(t);for(const [value,count] of [['true',1],['false',2],['',3]]){
 doc.querySelector('#republishFilter').value=value;await app.loadVideos({force:true});assert.equal(app.getVisibleVideos().length,count);assert.equal(new URL(requests.at(-1).url,'http://localhost').searchParams.get('is_republish'),value);}
});
test('preview defaults to hiding special rankings and keeps zero total authoritative',async t=>{
 const {app,doc,requests}=await setup(t);assert.equal(doc.querySelector('#previewShowSpecial').checked,false);await app.getPreview();assert.equal(app.previewTotal,0);assert.equal(new URL(requests.at(-1).url,'http://localhost').searchParams.has('show_special'),false);
 doc.querySelector('#previewShowSpecial').checked=true;await app.getPreview();assert.equal(new URL(requests.at(-1).url,'http://localhost').searchParams.has('show_special'),false);
});
test('preview renders seven data labels, special rank labels, escaped values, and 新投稿',async t=>{
 const {w}=await setup(t);const html=w.createPreviewCard({...video('BV8'),rank:0,specialRank:'hot',title:'<script>alert(1)</script>',isNew:true,view:1,like:2,share:3,coin:4,favorite:5,reply:6,danmaku:7});
 for(const label of ['播放','点赞','分享','硬币','收藏','评论','弹幕','新投稿','HOT']) assert.ok(html.includes(label));assert.ok(!html.includes('新上榜'));assert.ok(!html.includes('<script>alert'));assert.ok(html.includes('ranking-row'));
});
test('late asynchronous edit cannot replace newer edit or reopen cancelled panel',async t=>{
 const {app,doc,defer}=await setup(t);const finish=defer('BV8');const old=app.openEditPanelByBvid('BV8');app.openEditPanel('BV1');finish();await old;assert.equal(app.currentEditingBvid,'BV1');
 const finish2=defer('BV9');const cancelled=app.openEditPanelByBvid('BV9');app.closeEditPanel();finish2();await cancelled;assert.equal(doc.querySelector('#editPanel'),null);
});
test('navigation cancels current edit, saved local changes survive refresh',async t=>{
 const {w,app,doc}=await setup(t);app.openEditPanel('BV1');changeCheckbox(w,'#rank-sv input',true);click(doc,'[data-page="preview"]');assert.equal(doc.querySelector('#editPanel'),null);assert.deepEqual(clean(app.videos[0].ranks),['domestic']);
 await app.excludeVideo('BV1');await app.loadVideos({force:true});assert.deepEqual(clean(app.videos[0].ranks),[]);assert.equal(app.videos[0].is_examined,true);app.clearChanges();assert.deepEqual(clean(app.videos[0].ranks),['domestic']);
});

test('late preview response cannot overwrite newer HOT/SH visibility or page request',async t=>{
 const {w,app,doc}=await setup(t);const pending=[];
 w.fetch=url=>new Promise(resolve=>pending.push({url,resolve}));
 doc.querySelector('#previewShowSpecial').checked=true;const old=app.getPreview();
 doc.querySelector('#previewShowSpecial').checked=false;doc.querySelector('#previewIndex').value='2';const latest=app.getPreview();
 const answer=entries=>({ok:true,json:async()=>({success:true,data:{entries,stat:{count:entries.length},total:entries.length,has_next:false,next_cursor:null}})});
 await new Promise(resolve=>setTimeout(resolve,0));pending[1].resolve(answer([{...video('BV1'),rank:1,specialRank:'normal'}]));await latest;
 pending[0].resolve(answer([{...video('BV8'),rank:0,specialRank:'hot'}]));await old;
 assert.equal(app.previewData.entries[0].bvid,'BV1');assert.equal(app.previewShowSpecial,false);assert.ok(!doc.querySelector('#rankingPreview').textContent.includes('HOT'));
 app.previewTotal=40;app.previewPageSize=20;app.previewCursors[2]={rank:21,offset:0};app.previewChangePage(1);
 const newest=app.getPreview();await new Promise(resolve=>setTimeout(resolve,0));pending[3].resolve(answer([{...video('BV2'),rank:2}]));await newest;
 pending[2].resolve(answer([{...video('BV3'),rank:3}]));await new Promise(resolve=>setTimeout(resolve,0));assert.equal(app.previewData.entries[0].bvid,'BV2');
});

test('filter pruning prevents batch rejection of invisible previously selected items',async t=>{
 const {app,doc}=await setup(t);app.toggleVideoSelection('BV1',true);app.toggleVideoSelection('BV2',true);
 doc.querySelector('#republishFilter').value='true';app.applyRecordingFilters();app.batchReject();assert.deepEqual([...app.changes.keys()],['BV2']);
});

test('saved changes survive refresh/cancel and per-item removal restores original',async t=>{
 const {w,app}=await setup(t);await app.excludeVideo('BV1');await app.loadVideos({force:true});app.openEditPanel('BV1');changeCheckbox(w,'#rank-sv input',true);app.closeEditPanel();
 assert.deepEqual(clean(app.changes.get('BV1').ranks),[]);app.removeChange('BV1');assert.deepEqual(clean(app.videos[0]),initial[0]);assert.equal(app.changes.size,0);
});

test('mock submit carries exact exclusion state and unchanged metadata',async t=>{
 const {app,requests}=await setup(t);app.toggleVideoSelection('BV2',true);app.batchReject();await app.submitChanges();
 const submitted=requests.find(r=>r.url==='/api/submit-changes');assert.ok(submitted);assert.equal(submitted.options.method,'POST');
 assert.deepEqual(JSON.parse(submitted.options.body),{changes:[{avid:'av2',bvid:'BV2',ranks:[],is_examined:true,is_republish:true,staff_info:'原Staff'}]});assert.equal(app.changes.size,0);
});

test('changing preview criteria dismisses stale loading and ignores pending response',async t=>{
 const {w,app,doc}=await setup(t);let finish;w.fetch=()=>new Promise(resolve=>finish=resolve);const old=app.getPreview();
 doc.querySelector('#previewRank').value='sv';doc.querySelector('#previewRank').dispatchEvent(new w.Event('change',{bubbles:true}));
 assert.ok(doc.querySelector('#rankingPreview').textContent.includes('预览参数已更改'));await new Promise(resolve=>setTimeout(resolve,0));finish({ok:true,json:async()=>({success:true,data:{entries:[{...video('BV1'),rank:1}],stat:{count:1},total:1}})});await old;
 assert.equal(app.previewData,null);assert.ok(doc.querySelector('#rankingPreview').textContent.includes('预览参数已更改'));
});


test('HOT/SH toggles only filter loaded rows with zero requests and keep empty-page navigation',async t=>{
 const {w,app,doc,requests}=await setup(t);
 app.previewData={entries:[{...video('BV8'),rank:0,specialRank:'hot'}],stat:{count:4100},total:4100,has_next:true,next_cursor:{rank:21,offset:0}};app.previewTotal=4100;app.previewPageSize=20;app.renderPreview();
 const before=requests.length;assert.equal(doc.querySelectorAll('.ranking-row').length,0);assert.equal(doc.querySelector('#previewNextPageBtn').disabled,false);
 changeCheckbox(w,'#previewShowSpecial',true);assert.equal(doc.querySelectorAll('.ranking-row').length,1);
 changeCheckbox(w,'#previewShowSpecial',false);assert.equal(doc.querySelectorAll('.ranking-row').length,0);assert.equal(requests.length,before);
 assert.match(doc.querySelector('#previewPageInfo').textContent,/第 1 页/);
});

test('UTAU 35 HOT rows with nonzero ranks stay visible with numeric labels on every page',async t=>{
 const {w,app,doc,requests}=await setup(t);
 const ranked=[
  {...video('BV1DRzJYLEmB'),rank:21,special_rank:'hot',specialRank:'normal'},
  {...video('BV1sdCzB8Ez7'),rank:25,specialRank:'hot'},
  {...video('BV1JqjB6JE39'),rank:27,special_rank:'hot'},
  {...video('BV28'),rank:28,special_rank:'sh'},
 ];
 app.previewRank='utau';app.previewIndex=35;app.previewTotal=40;
 app.previewData={entries:ranked,special_entries:[{...video('BV8'),rank:0,special_rank:'hot'},{...video('BV9'),rank:0,special_rank:'sh'}],stat:{count:40},total:40,has_next:true};
 const before=requests.length;
 const labels=()=>[...doc.querySelectorAll('.ranking-row .ranking-rank')].map(el=>el.textContent);
 for(const page of [1,2]){
  app.previewPage=page;app.renderPreview();
  assert.deepEqual(labels(),['#21','#25','#27','#28']);
  changeCheckbox(w,'#previewShowSpecial',true);
  assert.deepEqual(labels(),page===1?['HOT','SH','#21','#25','#27','#28']:['#21','#25','#27','#28']);
  changeCheckbox(w,'#previewShowSpecial',false);
  assert.deepEqual(labels(),['#21','#25','#27','#28']);
 }
 assert.equal(requests.length,before);
});

test('identical in-flight preview clicks share one fetch; changed criteria abort old fetch',async t=>{
 const {w,app,doc}=await setup(t);const pending=[];
 w.fetch=(url,options)=>new Promise(resolve=>pending.push({url,options,resolve}));
 const first=app.getPreview(),again=app.getPreview();await new Promise(r=>setTimeout(r,0));assert.equal(pending.length,1);
 doc.querySelector('#previewIndex').value='2';const latest=app.getPreview();await new Promise(r=>setTimeout(r,0));assert.equal(pending.length,2); // WASM cannot abort the socket; the old response must be ignored.
 const answer=bvid=>({ok:true,json:async()=>({success:true,data:{entries:[{...video(bvid),rank:1}],stat:{count:1},total:1,has_next:false,next_cursor:null}})});
 pending[0].resolve(answer('BV1'));await Promise.all([first,again]);
 const sameLatest=app.getPreview();assert.equal(pending.length,2); // old finally must not clear new flight
 pending[1].resolve(answer('BV2'));await Promise.all([latest,sameLatest]);assert.equal(app.previewData.entries[0].bvid,'BV2');
});

test('preview timeout stops spinner without retrying',async t=>{
 const {w,app,doc}=await setup(t);let calls=0;const original=w.setTimeout.bind(w);
 w.setTimeout=(fn,ms)=>original(fn,ms===40000?0:ms);
 w.fetch=()=>new Promise(()=>{calls++;});
 await app.getPreview();assert.equal(calls,1);assert.match(doc.querySelector('#rankingPreview').textContent,/预览读取超时/);assert.equal(doc.querySelector('#rankingPreview .loading'),null);
});

test('legacy or malformed pagination produces an actionable error without retrying or caching',async t=>{
 const {w,app,doc}=await setup(t);const calls=[];
 const invalid=[{}, {has_next:'true'}, {has_next:true,next_cursor:null},
  {has_next:true,next_cursor:{rank:0,offset:1}}, {has_next:true,next_cursor:{rank:20,offset:-1}}];
 for(const pagination of invalid){
  w.fetch=async url=>{calls.push(url);return {ok:true,json:async()=>({success:true,data:{entries:[{...video('BV1'),rank:1}],stat:{count:40},total:40,...pagination}})};};
  const before=calls.length;await app.getPreview();assert.equal(calls.length,before+1);
  assert.equal(app.previewData,null);assert.equal(app.previewLoading,false);
  assert.match(doc.querySelector('#rankingPreview').textContent,/请联系管理员更新并重启服务/);
  assert.equal(doc.querySelectorAll('.ranking-row').length,0);assert.equal(doc.querySelector('#getPreviewBtn').disabled,false);
  assert.ok(calls.at(-1).includes('include_special=true'));
 }
 assert.match(w.createPreviewError(new Error('HTTP 400 page must be >= 1 and page_size must be between 1 and 110')),/请联系管理员更新并重启服务/);
 await w.getRankingPreview({rank:'domestic',index:1,page:1,pageSize:20,videoId:'av123'});
 assert.ok(!calls.at(-1).includes('include_special'));
});


test('rank-zero HOT/SH uses special_rank and is cached across toggles and pages',async t=>{
 const {w,app,doc}=await setup(t);const calls=[];
 const special=[{...video('BV8'),rank:0,special_rank:'hot',specialRank:'normal'},{...video('BV9'),rank:0,special_rank:'sh'}];
 w.fetch=async url=>{calls.push(url);return {ok:true,json:async()=>({success:true,data:{entries:[{...video('BV1'),rank:1,special_rank:'normal'}],special_entries:url.includes('include_special=true')?special:[],next_cursor:{rank:21,offset:0},has_next:true,stat:{count:40},total:40}})};};
 await app.getPreview();assert.equal(calls.length,1);assert.match(calls[0],/include_special=true/);assert.equal(doc.querySelectorAll('.ranking-row').length,1);
 changeCheckbox(w,'#previewShowSpecial',true);assert.equal(calls.length,1);assert.equal(doc.querySelectorAll('.ranking-row').length,3);assert.match(doc.querySelector('#rankingPreview').textContent,/HOT/);assert.match(doc.querySelector('#rankingPreview').textContent,/SH/);
 changeCheckbox(w,'#previewShowSpecial',false);assert.equal(calls.length,1);assert.equal(doc.querySelectorAll('.ranking-row').length,1);
 app.previewChangePage(1);await new Promise(r=>setTimeout(r,0));assert.equal(calls.length,2);assert.ok(!calls[1].includes('include_special'));
 changeCheckbox(w,'#previewShowSpecial',true);assert.equal(calls.length,2);assert.equal(doc.querySelectorAll('.ranking-row').length,1);
 await app.previewGoPage(1);assert.equal(calls.length,3);assert.ok(!calls[2].includes('include_special'));assert.equal(doc.querySelectorAll('.ranking-row').length,3);
});

test('recording exposes red batch exclusion; preview keeps neutral single exclusion',async t=>{
 const {w,app,doc}=await setup(t);
 assert.equal(doc.querySelectorAll('#videoList button[onclick*="excludeVideo"]').length,0);
 assert.equal(doc.querySelector('#batchRejectBtn .desktop-label').textContent,'批量排除');assert.ok(doc.querySelector('#batchRejectBtn').classList.contains('btn-danger'));
 app.openEditPanel('BV1');assert.equal(doc.querySelector('#editPanel button[onclick*="excludeEditingVideo"]'),null);app.closeEditPanel();
 app.currentPage='preview';app.openEditPanel('BV1');assert.ok(doc.querySelector('#editPanel button[onclick*="excludeEditingVideo"]').classList.contains('btn-secondary'));
 const card=w.createPreviewCard({...video('BV8'),rank:0,special_rank:'hot'});const box=doc.createElement('div');box.innerHTML=card;assert.ok(box.querySelector('button[onclick*="excludeVideo"]').classList.contains('btn-secondary'));
 assert.ok(!doc.body.textContent.includes('按原始排名区间'));
});

test('multi-rank OR filtering deduplicates and includes only unexamined unassigned other rows', async t => {
 const {w,app,doc,requests}=await setup(t);
 app.videos=[video('BV1',{ranks:['sv','utau']}),video('BV2',{ranks:['utau']}),video('BV3',{ranks:[]}),video('BV4',{ranks:[],is_examined:true})];
 const before=requests.length;
 for(const value of ['sv','utau','other']) changeCheckbox(w,`#rankFilter input[value="${value}"]`,true);
 assert.equal(requests.length,before);assert.match(doc.querySelector('#rankFilterSummary').textContent,/SV类、UTAU类、其他/);
 assert.deepEqual(clean(app.getVisibleVideos()).map(v=>v.bvid),['BV1','BV2','BV3']);
 await app.loadVideos({force:true});assert.equal(new URL(requests.at(-1).url,'http://localhost').searchParams.get('rank'),'sv,utau,other');
});

test('unified ID input sends only the recognized parameter and invalid ID sends nothing', async t => {
 const {app,doc,requests}=await setup(t);
 for(const [input,key,value] of [['AV123','avid','123'],['456','avid','456'],['BV1xx411c7mD','bvid','BV1xx411c7mD']]){
  doc.querySelector('#videoIdFilter').value=input;const before=requests.length;await app.loadVideos({force:true});
  assert.equal(requests.length,before+1);const q=new URL(requests.at(-1).url,'http://localhost').searchParams;assert.equal(q.get(key),value);assert.equal(q.get(key==='avid'?'bvid':'avid'),'');
 }
 doc.querySelector('#videoIdFilter').value='bad value';const before=requests.length;await app.loadVideos({force:true});assert.equal(requests.length,before);
});

test('preview exact search is one request, skips special scan, and shows matching HOT despite toggle',async t=>{
 const {w,app,doc,requests}=await setup(t);const calls=[];
 w.fetch=async url=>{calls.push(url);return {ok:true,json:async()=>({success:true,data:{search_id:'av123',entries:[{...video('BV8'),rank:0,special_rank:'hot',duration:125}],stat:{count:4100},total:4100}})};};
 doc.querySelector('#previewVideoId').value='AV123';await app.getPreview();assert.equal(calls.length,1);
 const q=new URL(calls[0],'http://localhost').searchParams;assert.equal(q.get('video_id'),'av123');assert.equal(q.has('include_special'),false);
 assert.equal(doc.querySelectorAll('.ranking-row').length,1);assert.match(doc.querySelector('.ranking-duration').textContent,/2:05/);assert.equal(doc.querySelector('#previewPaginationTop').style.display,'none');
 doc.querySelector('#previewVideoId').value='BV1';await app.getPreview();assert.equal(calls.length,1);
});

test('preview uses cursor navigation and exposes no jump controls',async t=>{
 const {w,app,doc}=await setup(t);const calls=[];
 w.fetch=async url=>{calls.push(url);return {ok:true,json:async()=>({success:true,data:{entries:[],stat:{count:4100},total:4100,has_next:true,next_cursor:{rank:20,offset:1}}})};};
 await app.getPreview();await app.previewGoPage(100);assert.equal(calls.length,1);
 await app.previewChangePage(1);assert.equal(calls.length,2);
 const query=new URL(calls[1],'http://localhost').searchParams;
 assert.equal(query.get('cursor_rank'),'20');assert.equal(query.get('cursor_offset'),'1');
 for(const suffix of ['', 'Top']) {assert.equal(doc.querySelector(`#previewPageInput${suffix}`),null);assert.match(doc.querySelector(`#previewPageInfo${suffix}`).textContent,/第 2 页/);}
});

test('failed next page keeps the current rows and cursor and allows a manual retry',async t=>{
 const {w,app,doc}=await setup(t);const calls=[];let fail=true;
 const first={entries:[{...video('BV1'),rank:20}],stat:{count:40},total:40,has_next:true,next_cursor:{rank:20,offset:1}};
 w.fetch=async url=>{
  calls.push(url);const page=new URL(url,'http://localhost').searchParams.get('page');
  if(page==='2'&&fail){fail=false;return {ok:false,status:503,json:async()=>({success:false,error:'Backend is busy'})};}
  return {ok:true,json:async()=>({success:true,data:page==='2'?{...first,entries:[{...video('BV2'),rank:21}],has_next:false,next_cursor:null}:first})};
 };
 await app.getPreview();const cursor=clean(app.previewCursors[2]);
 await app.previewChangePage(1);
 assert.equal(calls.length,2);assert.equal(app.previewPage,1);assert.equal(app.previewLoading,false);
 assert.equal(doc.querySelector('.ranking-row').dataset.bvid,'BV1');assert.match(doc.querySelector('#rankingPreview').textContent,/正在处理其他请求/);
 assert.deepEqual(clean(app.previewCursors[2]),cursor);
 for(const suffix of ['', 'Top']){
  assert.equal(doc.querySelector(`#previewNextPageBtn${suffix}`).disabled,false);
  assert.equal(doc.querySelector(`#previewPrevPageBtn${suffix}`).disabled,true);
  assert.match(doc.querySelector(`#previewPageInfo${suffix}`).textContent,/第 1 页/);
 }
 await app.previewChangePage(1);assert.equal(calls.length,3);assert.equal(app.previewPage,2);
 assert.equal(doc.querySelector('.ranking-row').dataset.bvid,'BV2');assert.equal(doc.querySelector('#rankingPreview [role="status"]'),null);
 for(const suffix of ['', 'Top']){
  assert.equal(doc.querySelector(`#previewNextPageBtn${suffix}`).disabled,true);
  assert.equal(doc.querySelector(`#previewPrevPageBtn${suffix}`).disabled,false);
 }
 const retry=new URL(calls[2],'http://localhost').searchParams;
 assert.equal(retry.get('cursor_rank'),String(cursor.rank));assert.equal(retry.get('cursor_offset'),String(cursor.offset));
});

test('preview exclusion and undo update immediately without reloading; submit preserves marker',async t=>{
 const {app,doc,requests}=await setup(t);
 app.previewData={entries:[{...video('BV1'),rank:1}],stat:{count:1},total:1};app.previewTotal=1;app.renderPreview();
 const before=requests.length;await app.excludeVideo('BV1');assert.equal(requests.length,before);assert.match(doc.querySelector('.ranking-row').textContent,/已排除 · 待提交/);
 app.removeChange('BV1');assert.equal(doc.querySelector('.ranking-excluded'),null);
 await app.excludeVideo('BV1');await app.submitChanges();assert.ok(doc.querySelector('.ranking-excluded'));assert.ok(!doc.querySelector('.ranking-row').textContent.includes('待提交'));
});

test('preview empty and failure states are distinct and error detail is escaped',async t=>{
 const {w}=await setup(t);
 assert.match(w.createPreviewContent({data:{entries:[],search_id:'av123'},previewRank:'sv',previewIndex:3}),/未找到 av123/);
 const html=w.createPreviewError(new Error('HTTP 500 <img src=x onerror=alert(1)>'));
 assert.match(html,/暂时无法读取/);assert.ok(!html.includes('<img'));assert.ok(!html.includes('暂无视频数据'));
});

test('changing page size waits for manual preview and resets navigation without a request',async t=>{
 const {w,app,doc,requests}=await setup(t);
 await app.getPreview();
 for(const size of ['80','120']){
  app.previewPage=2;app.previewCursors[2]={rank:20,offset:1};
  const select=doc.querySelector('#previewPageSize');select.value=size;
  const before=requests.length;select.dispatchEvent(new w.Event('change',{bubbles:true}));await new Promise(r=>setTimeout(r,0));
  assert.equal(requests.length,before);assert.equal(app.previewPage,1);assert.equal(app.previewData,null);
  assert.deepEqual(clean(app.previewCursors),{'1':{rank:1,offset:0}});
  assert.match(doc.querySelector('#rankingPreview').textContent,/请点击“预览”/);
  doc.querySelector('#getPreviewBtn').click();await new Promise(r=>setTimeout(r,0));
  assert.equal(requests.length,before+1);const query=new URL(requests.at(-1).url,'http://localhost').searchParams;
  assert.equal(query.get('page_size'),size);assert.equal(query.get('page'),'1');assert.equal(app.previewLoading,false);
 }
});


test('clear recording filters resets today and page with one request, preserving layout and pending changes',async t=>{
 const {w,app,doc,requests}=await setup(t);
 await app.excludeVideo('BV1');
 doc.querySelector('#dateFilter').value='2026-01-01';
 doc.querySelector('#searchKeyword').value='keyword';
 doc.querySelector('#videoIdFilter').value='av123';
 doc.querySelector('#examinedFilter').value='true';
 doc.querySelector('#republishFilter').value='true';
 changeCheckbox(w,'#rankFilter input[value="sv"]',true);
 doc.querySelector('#currentPage').value='5';doc.querySelector('#currentPageBottom').value='5';
 doc.querySelector('#pageSizeSelect').value='100';app.setLayoutMode('single');
 const before=requests.length;
 doc.querySelector('#clearRecordingFiltersBtn').click();await new Promise(r=>setTimeout(r,0));
 assert.equal(requests.length,before+1);
 const q=new URL(requests.at(-1).url,'http://localhost').searchParams;
 for(const key of ['keyword','bvid','avid','examined','is_republish']) assert.equal(q.get(key),'');
 assert.equal(q.get('date'),w.formatLocalDateInput());assert.equal(q.get('rank'),'all');assert.equal(q.get('page'),'1');assert.equal(q.get('page_size'),'100');
 assert.equal(doc.querySelector('#rankFilterSummary').textContent,'全部期刊');assert.equal(doc.querySelectorAll('#rankFilter input:checked').length,0);
 assert.equal(doc.querySelector('#currentPageBottom').value,'1');assert.equal(app.layoutMode,'single');assert.equal(app.changes.size,1);
});

test('special rows and truncation notice appear only on first page without fetching on toggle',async t=>{
 const {w,app,doc,requests}=await setup(t);
 app.previewData={entries:[{...video('BV1'),rank:21},{...video('BV2'),rank:22,special_rank:'hot'}],special_entries:[{...video('BV8'),rank:0,special_rank:'sh'}],special_truncated:true,next_cursor:{rank:21,offset:0},has_next:true,stat:{count:40},total:40};app.previewTotal=40;app.previewPage=2;
 const before=requests.length;changeCheckbox(w,'#previewShowSpecial',true);
 assert.equal(doc.querySelectorAll('.ranking-row').length,2);assert.ok(!doc.querySelector('#rankingPreview').textContent.includes('超过显示上限'));
 app.previewPage=1;app.renderPreview();assert.equal(doc.querySelectorAll('.ranking-row').length,3);assert.match(doc.querySelector('#rankingPreview').textContent,/超过显示上限/);
 assert.equal(requests.length,before);
});

test('WASM auth, numeric parameters, retry and read-only validation', async t => {
 const {w}=await setup(t);const calls=[];
 w.localStorage.setItem('cvse_api_key','secret');
 w.__request=async (method, params, auth) => {
  calls.push({method,params,auth});
  if(method==='getVideos' && calls.filter(c=>c.method==='getVideos').length===1) throw new Error('connection failed');
  return {success:true,data:{has_next:false,next_cursor:null},total:0};
 };
 await assert.rejects(w.getVideos({page:2,page_size:20}),/connection failed/);
 await w.getVideos({page:2,page_size:20});
 assert.equal(calls.length,2);assert.equal(calls[0].auth,'secret');assert.equal(calls[1].auth,'secret');
 assert.equal(calls[1].params.page,2);assert.equal(calls[1].params.page_size,20);
 await w.getRankingPreview({rank:'domestic',index:2,page:1,pageSize:20,cursor:{rank:21,offset:3}});
 assert.equal(calls[2].params.index,2);assert.equal(calls[2].params.cursor_rank,21);assert.equal(calls[2].params.cursor_offset,3);
 const validation=await w.validateAuthKey('secret');
 assert.equal(validation.valid,false);assert.match(validation.message,/只读 RPC 无法验证/);
 assert.equal(calls.length,3);
});

function themeSetup(t, { saved = null, dark = false, blockedStorage = false } = {}) {
 const dom=new JSDOM('<!doctype html><select id="themeSelect"><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select>',{url:'http://localhost',runScripts:'dangerously'});
 const w=dom.window,media=new w.EventTarget();media.matches=dark;w.matchMedia=()=>media;
 if(saved!==null)w.localStorage.setItem('cvse_theme',saved);
 if(blockedStorage)Object.defineProperty(w,'localStorage',{get(){throw new Error('Storage blocked');}});
 w.eval(fs.readFileSync(path.join(root,'static/js/theme.js'),'utf8'));
 w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
 t.after(()=>w.close());
 return {w,media,select(mode){const el=w.document.querySelector('#themeSelect');el.value=mode;el.dispatchEvent(new w.Event('change',{bubbles:true}));},theme:()=>w.document.documentElement.dataset.theme};
}

test('theme defaults to system, tracks changes, and manual override persists',t=>{
 const {w,media,select,theme}=themeSetup(t,{dark:true});
 assert.equal(theme(),'dark');assert.equal(w.document.querySelector('#themeSelect').value,'system');
 media.matches=false;media.dispatchEvent(new w.Event('change'));assert.equal(theme(),'light');
 select('dark');assert.equal(theme(),'dark');assert.equal(w.localStorage.getItem('cvse_theme'),'dark');
 media.dispatchEvent(new w.Event('change'));assert.equal(theme(),'dark');
 select('system');assert.equal(theme(),'light');media.matches=true;media.dispatchEvent(new w.Event('change'));assert.equal(theme(),'dark');
});

test('theme restores preference, handles other tabs and invalid settings',t=>{
 const {w,theme}=themeSetup(t,{saved:'light',dark:true});assert.equal(theme(),'light');
 w.dispatchEvent(new w.StorageEvent('storage',{key:'cvse_theme',newValue:'dark'}));assert.equal(theme(),'dark');assert.equal(w.document.querySelector('#themeSelect').value,'dark');
 w.dispatchEvent(new w.StorageEvent('storage',{key:'cvse_theme',newValue:'invalid'}));assert.equal(theme(),'dark');assert.equal(w.document.querySelector('#themeSelect').value,'system');
});

test('theme works when persistent storage is blocked',t=>{
 const {theme,select}=themeSetup(t,{dark:true,blockedStorage:true});assert.equal(theme(),'dark');select('light');assert.equal(theme(),'light');
});
