import { connectedAdmissionCpuInput, runConnectedAdmissionCpu, checkConnectedAdmissionCpu, type ConnectedAdmissionCpuFixture } from './connected-room-admission-cpu.fixture.ts';
Deno.test('synthetic full accepted population survives actual room admission without inference or omitted receivers',async()=>{
  const fixture=JSON.parse(new TextDecoder().decode(connectedAdmissionCpuInput())) as ConnectedAdmissionCpuFixture;
  checkConnectedAdmissionCpu(await runConnectedAdmissionCpu(fixture));
});
