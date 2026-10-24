import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import { replanAuditReason, replanAuditState } from './replan-audit.ts';
const en = (_sv: string, english: string) => english;
Deno.test('audit labels distinguish configuration, manual requests and unknown historical attribution', () => {
  assertStringIncludes(replanAuditReason({reason:'controller_source_selected'},en),'Controller source');
  assertStringIncludes(replanAuditReason({reason:'pending_configuration_on_startup'},en),'pending at startup');
  assertStringIncludes(replanAuditReason({reason:'manual_replan_button'},en),'portal button');
  assertStringIncludes(replanAuditReason({reason:'unattributed_database_request'},en),'no recorded initiator');
  assertStringIncludes(replanAuditState('published',en),'awaiting home acceptance');
  assertEquals(replanAuditState('accepted',en),'Accepted by home');
  assertEquals(replanAuditState('published',en,'publication'),'Published');
});
Deno.test('audit labels retain measured shortfall and persistence and identify a missed charging opportunity', () => {
  assertEquals(replanAuditReason({changes:[{owner:'$battery',cause:'battery_energy_shortfall',magnitude:.225,persistence_ms:120000}]},en),
    'Home battery shortfall: 0.225 kWh (2 min).');
  assertStringIncludes(replanAuditReason({changes:[{owner:'$ev',cause:'vehicle_disconnected'}]},en),'when charging was scheduled');
  assertStringIncludes(replanAuditReason({changes:[{owner:'$pool',cause:'required_source_unavailable'}]},en),'pool was unavailable for at least 15 minutes');
});
