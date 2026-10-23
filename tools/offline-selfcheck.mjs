/* Model-free checks of real SW handlers and the app's reset path. */
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const root = new URL('../',import.meta.url), origin='https://example.github.io';
const script=fs.readFileSync(new URL('sw.js',root),'utf8');
function harness(){
  const data=new Map(),handlers={},base=origin+'/Aloud/';let openCount=0,writeGate=null,failWrite=false;
  const key=k=>new URL(typeof k==='string'?k:k.url,base).href;
  const cache=name=>{if(!data.has(name))data.set(name,new Map());const values=data.get(name);return{
    async keys(){return [...values.keys()].map(url=>new Request(url));},async match(k){return values.get(key(k))?.clone();},async put(k,v){if(failWrite)throw Error('storage unavailable');values.set(key(k),v);},async delete(k){return values.delete(key(k));},async addAll(paths){for(const p of paths)values.set(key(p),new Response('shell'));}
  };};
  const caches={async match(k){for(const values of data.values()){const hit=values.get(key(k));if(hit)return hit.clone();}},async keys(){return [...data.keys()];},async delete(k){return data.delete(k);},async open(name){openCount++;if(writeGate&&openCount===1)await writeGate;return cache(name);}};
  const c={caches,location:{origin},URL,Response,Headers,console:{warn(){}},fetch:async()=>new Response('module source'),self:{addEventListener:(n,fn)=>handlers[n]=fn,skipWaiting:async()=>{},clients:{claim:async()=>{}}}};
  vm.createContext(c);vm.runInContext(script,c);
  const dispatch=(name,extra={})=>{const waits=[];let response;handlers[name]({...extra,waitUntil:p=>waits.push(p),respondWith:p=>{response=p}});return{waits,get response(){return response}};};
  return{c,data,caches,cache,dispatch,version:vm.runInContext('VERSION',c),core:vm.runInContext('CORE',c),delayWrites(p){openCount=0;writeGate=p;},failWrites(){failWrite=true;}};
}
{
 const h=harness();for(const name of ['aloud-v1.0.0',h.version,'aloud-flags','aloud-voices','other-app','transformers-cache'])h.cache(name);
 await h.cache('aloud-flags').put('/__aloud_coi',new Response('1'));
 await h.cache('aloud-v1.0.0').put('https://cdn.jsdelivr.net/npm/example/cached.js',new Response('cached engine')); 
 await Promise.all(h.dispatch('activate').waits);
 assert.equal(await (await h.cache('aloud-modules').match('https://cdn.jsdelivr.net/npm/example/cached.js')).text(),'cached engine');
 assert(!h.data.has('aloud-v1.0.0'));for(const n of [h.version,'aloud-flags','aloud-voices','other-app','transformers-cache'])assert(h.data.has(n));
 let status;await Promise.all(h.dispatch('message',{data:{type:'status'},ports:[{postMessage:s=>{status=s}}]}).waits);assert.equal(status.ready,false);
 await Promise.all(h.dispatch('install').waits);
 await Promise.all(h.dispatch('message',{data:{type:'status'},ports:[{postMessage:s=>{status=s}}]}).waits);assert.equal(status.ready,true);assert.equal(status.version,h.version.slice(6));
 await h.cache(h.version).delete(h.core.at(-1));await Promise.all(h.dispatch('message',{data:{type:'status'},ports:[{postMessage:s=>{status=s}}]}).waits);assert.equal(status.ready,false);
}
{
 const h=harness();await h.cache('aloud-v1.0.0').put('https://cdn.jsdelivr.net/npm/example/retained.js',new Response('retained engine'));h.failWrites();await Promise.all(h.dispatch('activate').waits);assert(h.data.has('aloud-v1.0.0'),'Failed migration must retain the cached engine');const e=h.dispatch('fetch',{request:new Request('https://cdn.jsdelivr.net/npm/example/retained.js')});assert.equal(await (await e.response).text(),'retained engine');await Promise.all(e.waits);
}
{
 const h=harness();let release;h.delayWrites(new Promise(resolve=>{release=resolve}));
 const event=h.dispatch('fetch',{request:new Request('https://cdn.jsdelivr.net/npm/example/module.js')});assert.equal(event.waits.length,1,'cache write needs synchronous lifetime registration');
 const response=await event.response;assert.equal(await response.text(),'module source');release();await Promise.all(event.waits);
 assert.equal(await (await h.cache('aloud-modules').match('https://cdn.jsdelivr.net/npm/example/module.js')).text(),'module source','Response must be cloned before the caller consumes it');
 const failed=harness();failed.failWrites();const f=failed.dispatch('fetch',{request:new Request('https://cdn.jsdelivr.net/npm/example/fail.js')});assert.equal(await (await f.response).text(),'module source');await Promise.all(f.waits);
}
{
 const html=fs.readFileSync(new URL('index.html',root),'utf8'),a=html.indexOf('const RESETTING ='),b=html.indexOf('/* ---------------- safe storage',a);
 const storage={'aloud.engine':'"neural"','aloud.htmlls.test':'{}','another-app.setting':'keep'};
 Object.defineProperty(storage,'removeItem',{value:key=>delete storage[key]});
 const deleted=[],unregistered=[];const scopes=[origin+'/',origin+'/Other/',origin+'/Aloud/'];
 const caches={keys:async()=>['aloud-v6.0.0','aloud-flags','other-cache','transformers-cache'],delete:async k=>deleted.push(k)};
 let redirected;let finish;const done=new Promise(resolve=>{finish=resolve});
 const c={URL,localStorage:storage,window:{caches},caches,navigator:{serviceWorker:{getRegistrations:async()=>scopes.map(scope=>({scope,unregister:async()=>unregistered.push(scope)}))}},indexedDB:{deleteDatabase:name=>{assert.equal(name,'aloud');const request={};queueMicrotask(()=>request.onsuccess());return request;}},location:{href:origin+'/Aloud/index.html?reset',origin,pathname:'/Aloud/index.html',search:'?reset',replace:url=>{redirected=url;finish()}},document:{body:null},setTimeout:fn=>{fn();},Date};
 vm.createContext(c);vm.runInContext(html.slice(a,b),c);await done;
 assert.deepEqual(Object.keys(storage),['another-app.setting']);assert.deepEqual(deleted,['aloud-v6.0.0','aloud-flags']);assert.deepEqual(unregistered,[origin+'/Aloud/']);assert(redirected.startsWith(origin+'/Aloud/index.html?fresh='));
}
console.log('PASS: scoped reset preserves other apps; activation preserves flags/voice/foreign caches; offline status requires every shell asset; cached engine dependencies survive shell upgrades; CDN clone survives immediate body consumption; waitUntil holds the write; storage failure does not break the response.');
