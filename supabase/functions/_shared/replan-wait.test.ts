import { assertEquals, assertRejects } from 'jsr:@std/assert@1';
import { waitForReplan } from './replan-wait.ts';

Deno.test('a request between subscription and durable read is not lost', async () => {
  let subscribed = false; let closed = false;
  const result = await waitForReplan({after:null, signal:new AbortController().signal,
    subscribe: () => { subscribed=true; return {ready:Promise.resolve(), lost:new Promise<void>(()=>{}), close:async()=>{closed=true;}}; },
    read:async()=> { assertEquals(subscribed,true); return 'request'; }, holdMs:100});
  assertEquals(result,'request'); assertEquals(closed,true);
});
Deno.test('a broadcast triggers a durable reread and an answered ID is suppressed', async () => {
  let value = 'old'; let wake!:()=>void; let reads=0;
  const result = await waitForReplan({after:'old', signal:new AbortController().signal,
    subscribe:changed=>{wake=changed;return {ready:Promise.resolve(), lost:new Promise<void>(()=>{}),close:async()=>{}};},
    read:async()=>{ reads++; if(reads===1){queueMicrotask(()=>{value='new';wake();});return 'old';} return value;},holdMs:100});
  assertEquals(result,'new'); assertEquals(reads,2);
});
Deno.test('quiet timeout and cancellation close the subscription', async () => {
  let closed=0;
  const subscribe=()=>({ready:Promise.resolve(), lost:new Promise<void>(()=>{}),close:async()=>{closed++;}});
  assertEquals(await waitForReplan({after:'old',read:async()=>'old',subscribe,signal:new AbortController().signal,holdMs:1}),null);
  const controller=new AbortController(); controller.abort();
  await assertRejects(()=>waitForReplan({after:null,read:async()=>null,subscribe,signal:controller.signal,holdMs:100}));
  assertEquals(closed,2);
});

Deno.test('a readiness timeout cannot become a successful durable poll', async () => {
  let reads=0, closed=false;
  await assertRejects(()=>waitForReplan({after:null,signal:new AbortController().signal,readyMs:1,
    subscribe:()=>({ready:new Promise<void>(()=>{}),lost:new Promise<void>(()=>{}),close:async()=>{closed=true;}}),
    read:async()=>{reads++;return null;},holdMs:1}));
  assertEquals(reads,0);assertEquals(closed,true);
});
Deno.test('channel loss after readiness interrupts the active wait', async () => {
  let lose!:()=>void, reads=0,closed=false;
  const lost=new Promise<void>(resolve=>{lose=resolve;});
  await assertRejects(()=>waitForReplan({after:null,signal:new AbortController().signal,
    subscribe:()=>({ready:Promise.resolve(),lost,close:async()=>{closed=true;}}),
    read:async()=>{reads++;queueMicrotask(lose);return null;},holdMs:1000}));
  assertEquals(reads,1);assertEquals(closed,true);
});
