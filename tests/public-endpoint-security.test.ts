import { PGlite } from 'npm:@electric-sql/pglite@0.3.14';
import { assertEquals, assertRejects } from 'jsr:@std/assert@1';
import { consumeRateLimit } from '../supabase/functions/_shared/rate-limit.ts';
import { claimVerificationToken } from '../supabase/functions/_shared/verification-token.ts';

Deno.test('public rate limits count a burst atomically, reset expired rows, and isolate endpoints and callers', async () => {
  const db = new PGlite();
  try {
    await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;');
    await db.exec(await Deno.readTextFile('supabase/migrations/20260123091606_05d5be19-4e46-4a08-8511-2bc43e62db42.sql'));
    await db.exec(await Deno.readTextFile('supabase/migrations/20261022101500_atomic_public_endpoint_rate_limits.sql'));
    const consume = (identifier = 'caller', endpoint = 'contact_form') => db.query<{allowed: boolean; remaining: number}>(
      'SELECT * FROM consume_rate_limit($1,$2,5,900)', [identifier, endpoint]);
    const burst = await Promise.all(Array.from({ length: 30 }, () => consume()));
    assertEquals(burst.filter(r => r.rows[0].allowed).length, 5);
    assertEquals(burst.at(-1)!.rows[0], { allowed: false, remaining: 0 });
    assertEquals((await consume('other')).rows[0].allowed, true);
    assertEquals((await consume('caller', 'resolve-verification')).rows[0].allowed, true);
    await db.exec("UPDATE rate_limits SET window_start=now()-interval '16 minutes' WHERE identifier='caller' AND endpoint='contact_form'");
    assertEquals((await consume()).rows[0], {allowed: true, remaining: 4});
    const privileges = await db.query<{role: string; allowed: boolean}>(`SELECT role,
      has_function_privilege(role,'consume_rate_limit(text,text,integer,integer)','EXECUTE') AS allowed
      FROM unnest(ARRAY['anon','authenticated','service_role']) AS role`);
    assertEquals(privileges.rows, [{role:'anon',allowed:false},{role:'authenticated',allowed:false},{role:'service_role',allowed:true}]);
  } finally { await db.close(); }
});

Deno.test('rate-limit errors and missing or invalid decisions never allow protected work', async () => {
  for (const reply of [{data:null,error:{message:'unavailable'}},{data:[],error:null},
    {data:[{allowed:'true',remaining:4}],error:null}]) {
    const client = {rpc: () => Promise.resolve(reply)} as unknown as Parameters<typeof consumeRateLimit>[0];
    await assertRejects(() => consumeRateLimit(client, 'caller', 'contact_form', 5, 900), Error, 'Rate limit storage unavailable');
  }
});

Deno.test('a verification link must win its conditional claim before a session is issued', async () => {
  for (const [reply, expected] of [[{data:{id:'token'},error:null},true],
    [{data:null,error:null},false],[{data:{},error:null},false],
    [{data:null,error:{message:'database error'}},false]] as const) {
    const calls: string[] = [];
    const query = { update() { calls.push('update'); return query; }, eq(column: string, value: string) {
      calls.push(`${column}=${value}`); return query; }, is(column: string, value: null) {
      calls.push(`${column}=${value}`); return query; }, select(column: string) {
      calls.push(`return ${column}`); return query; }, maybeSingle: () => Promise.resolve(reply) };
    const client = {from() { return query; }} as unknown as Parameters<typeof claimVerificationToken>[0];
    assertEquals(await claimVerificationToken(client, 'token'), expected);
    assertEquals(calls, ['update','id=token','used_at=null','return id']);
  }
});
