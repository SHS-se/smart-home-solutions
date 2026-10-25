import { assertEquals } from "@std/assert";
import { PoolSourceKernel } from "../../planner/device-models.ts";

// Independently specified synthetic states, pinned to the pre-optimization
// kernel. Exact arithmetic parity, including zero lag and linear input slopes.
const cases: {parameters: ConstructorParameters<typeof PoolSourceKernel>; args: Parameters<PoolSourceKernel["piece"]>; expected: ReturnType<PoolSourceKernel["piece"]>}[] = [
  {"parameters":[60,0,{"recovery_rate_per_h":0,"heat_loss_per_kwh":0.025},4.5],"args":[30,2,4,3,-0.4,0.25,-0.02],"expected":{"water_c":30.07760467122396,"pending_heat_kwh":0,"source_depletion_kwh":4.7375,"heat_kwh":2.9562802734374993}},
  {"parameters":[60,0,{"recovery_rate_per_h":0,"heat_loss_per_kwh":0.025},4.5],"args":[30,2,4,3,0,0.25,-0.02],"expected":{"water_c":30.078430989583335,"pending_heat_kwh":0,"source_depletion_kwh":4.75,"heat_kwh":3.005859375}},
  {"parameters":[60,0,{"recovery_rate_per_h":0,"heat_loss_per_kwh":0.025},4.5],"args":[30,2,4,3,0.7,0.25,-0.02],"expected":{"water_c":30.079876341756187,"pending_heat_kwh":0,"source_depletion_kwh":4.771875,"heat_kwh":3.0925805053710933}},
  {"parameters":[60,0,{"recovery_rate_per_h":0.18,"heat_loss_per_kwh":0.025},4.5],"args":[30,2,4,3,-0.4,0.25,-0.02],"expected":{"water_c":30.077734153821122,"pending_heat_kwh":0,"source_depletion_kwh":4.545050639581971,"heat_kwh":2.9640492292673613}},
  {"parameters":[60,0,{"recovery_rate_per_h":0.18,"heat_loss_per_kwh":0.025},4.5],"args":[30,2,4,3,0,0.25,-0.02],"expected":{"water_c":30.0785634967744,"pending_heat_kwh":0,"source_depletion_kwh":4.557365230114069,"heat_kwh":3.013809806463877}},
  {"parameters":[60,0,{"recovery_rate_per_h":0.18,"heat_loss_per_kwh":0.025},4.5],"args":[30,2,4,3,0.7,0.25,-0.02],"expected":{"water_c":30.080014150367347,"pending_heat_kwh":0,"source_depletion_kwh":4.57891576354524,"heat_kwh":3.100849022040871}},
  {"parameters":[60,0,{"recovery_rate_per_h":1.4285714285714286,"heat_loss_per_kwh":0.025},4.5],"args":[30,2,4,3,-0.4,0.25,-0.02],"expected":{"water_c":30.078535563023514,"pending_heat_kwh":0,"source_depletion_kwh":3.4182420036872263,"heat_kwh":3.0121337814107667}},
  {"parameters":[60,0,{"recovery_rate_per_h":1.4285714285714286,"heat_loss_per_kwh":0.025},4.5],"args":[30,2,4,3,0,0.25,-0.02],"expected":{"water_c":30.079383383503572,"pending_heat_kwh":0,"source_depletion_kwh":3.4293778210127517,"heat_kwh":3.0630030102142616}},
  {"parameters":[60,0,{"recovery_rate_per_h":1.4285714285714286,"heat_loss_per_kwh":0.025},4.5],"args":[30,2,4,3,0.7,0.25,-0.02],"expected":{"water_c":30.080866426821462,"pending_heat_kwh":0,"source_depletion_kwh":3.4488655013324214,"heat_kwh":3.1519856092876855}},
  {"parameters":[60,0,{"recovery_rate_per_h":128,"heat_loss_per_kwh":0.025},4.5],"args":[30,2,4,3,-0.4,0.25,-0.02],"expected":{"water_c":30.083439358837282,"pending_heat_kwh":0,"source_depletion_kwh":0.022680664062550315,"heat_kwh":3.3063615302368996}},
  {"parameters":[60,0,{"recovery_rate_per_h":128,"heat_loss_per_kwh":0.025},4.5],"args":[30,2,4,3,0,0.25,-0.02],"expected":{"water_c":30.08437562306722,"pending_heat_kwh":0,"source_depletion_kwh":0.023437500000050314,"heat_kwh":3.362537384033203}},
  {"parameters":[60,0,{"recovery_rate_per_h":128,"heat_loss_per_kwh":0.025},4.5],"args":[30,2,4,3,0.7,0.25,-0.02],"expected":{"water_c":30.08601402947163,"pending_heat_kwh":0,"source_depletion_kwh":0.024761962890675313,"heat_kwh":3.460841768297834}},
  {"parameters":[60,0.7,{"recovery_rate_per_h":0,"heat_loss_per_kwh":0.025},4.5],"args":[30,2,4,3,-0.4,0.25,-0.02],"expected":{"water_c":30.012916317653033,"pending_heat_kwh":3.8813012142556165,"source_depletion_kwh":4.7375,"heat_kwh":2.9562802734374993}},
  {"parameters":[60,0.7,{"recovery_rate_per_h":0,"heat_loss_per_kwh":0.025},4.5],"args":[30,2,4,3,0,0.25,-0.02],"expected":{"water_c":30.013006946137175,"pending_heat_kwh":3.9254426067695443,"source_depletion_kwh":4.75,"heat_kwh":3.005859375}},
  {"parameters":[60,0.7,{"recovery_rate_per_h":0,"heat_loss_per_kwh":0.025},4.5],"args":[30,2,4,3,0.7,0.25,-0.02],"expected":{"water_c":30.013165498481328,"pending_heat_kwh":4.002650596491516,"source_depletion_kwh":4.771875,"heat_kwh":3.0925805053710933}},
  {"parameters":[60,0.7,{"recovery_rate_per_h":0.18,"heat_loss_per_kwh":0.025},4.5],"args":[30,2,4,3,-0.4,0.25,-0.02],"expected":{"water_c":30.01293037754016,"pending_heat_kwh":3.8882265768576554,"source_depletion_kwh":4.545050639581971,"heat_kwh":2.9640492292673613}},
  {"parameters":[60,0.7,{"recovery_rate_per_h":0.18,"heat_loss_per_kwh":0.025},4.5],"args":[30,2,4,3,0,0.25,-0.02],"expected":{"water_c":30.013021254554925,"pending_heat_kwh":3.932534533168341,"source_depletion_kwh":4.557365230114069,"heat_kwh":3.013809806463877}},
  {"parameters":[60,0.7,{"recovery_rate_per_h":0.18,"heat_loss_per_kwh":0.025},4.5],"args":[30,2,4,3,0.7,0.25,-0.02],"expected":{"water_c":30.01318024230277,"pending_heat_kwh":4.010034483874672,"source_depletion_kwh":4.57891576354524,"heat_kwh":3.100849022040871}},
  {"parameters":[60,0.7,{"recovery_rate_per_h":1.4285714285714286,"heat_loss_per_kwh":0.025},4.5],"args":[30,2,4,3,-0.4,0.25,-0.02],"expected":{"water_c":30.01301972931855,"pending_heat_kwh":3.9309500222977807,"source_depletion_kwh":3.4182420036872263,"heat_kwh":3.0121337814107667}},
  {"parameters":[60,0.7,{"recovery_rate_per_h":1.4285714285714286,"heat_loss_per_kwh":0.025},4.5],"args":[30,2,4,3,0,0.25,-0.02],"expected":{"water_c":30.01311216049503,"pending_heat_kwh":3.976273380512568,"source_depletion_kwh":3.4293778210127517,"heat_kwh":3.0630030102142616}},
  {"parameters":[60,0.7,{"recovery_rate_per_h":1.4285714285714286,"heat_loss_per_kwh":0.025},4.5],"args":[30,2,4,3,0.7,0.25,-0.02],"expected":{"water_c":30.013273871120592,"pending_heat_kwh":4.055553342052114,"source_depletion_kwh":3.4488655013324214,"heat_kwh":3.1519856092876855}},
  {"parameters":[60,0.7,{"recovery_rate_per_h":128,"heat_loss_per_kwh":0.025},4.5],"args":[30,2,4,3,-0.4,0.25,-0.02],"expected":{"water_c":30.013800846112552,"pending_heat_kwh":4.178310763483793,"source_depletion_kwh":0.022680664062550315,"heat_kwh":3.3063615302368996}},
  {"parameters":[60,0.7,{"recovery_rate_per_h":128,"heat_loss_per_kwh":0.025},4.5],"args":[30,2,4,3,0,0.25,-0.02],"expected":{"water_c":30.013902994238407,"pending_heat_kwh":4.228357729728754,"source_depletion_kwh":0.023437500000050314,"heat_kwh":3.362537384033203}},
  {"parameters":[60,0.7,{"recovery_rate_per_h":128,"heat_loss_per_kwh":0.025},4.5],"args":[30,2,4,3,0.7,0.25,-0.02],"expected":{"water_c":30.01408174886589,"pending_heat_kwh":4.315936836344445,"source_depletion_kwh":0.024761962890675313,"heat_kwh":3.460841768297834}},
  {"parameters":[60,1000,{"recovery_rate_per_h":0,"heat_loss_per_kwh":0.025},4.5],"args":[30,2,4,3,-0.4,0.25,-0.02],"expected":{"water_c":29.995014546730026,"pending_heat_kwh":4.955407469636009,"source_depletion_kwh":4.7375,"heat_kwh":2.9562802734374993}},
  {"parameters":[60,1000,{"recovery_rate_per_h":0,"heat_loss_per_kwh":0.025},4.5],"args":[30,2,4,3,0,0.25,-0.02],"expected":{"water_c":29.99501461594688,"pending_heat_kwh":5.004982418187405,"source_depletion_kwh":4.75,"heat_kwh":3.005859375}},
  {"parameters":[60,1000,{"recovery_rate_per_h":0,"heat_loss_per_kwh":0.025},4.5],"args":[30,2,4,3,0.7,0.25,-0.02],"expected":{"water_c":29.99501473704112,"pending_heat_kwh":5.09169628290385,"source_depletion_kwh":4.771875,"heat_kwh":3.0925805053710933}},
  {"parameters":[60,1000,{"recovery_rate_per_h":0.18,"heat_loss_per_kwh":0.025},4.5],"args":[30,2,4,3,-0.4,0.25,-0.02],"expected":{"water_c":29.995014557462188,"pending_heat_kwh":4.963175781536124,"source_depletion_kwh":4.545050639581971,"heat_kwh":2.9640492292673613}},
  {"parameters":[60,1000,{"recovery_rate_per_h":0.18,"heat_loss_per_kwh":0.025},4.5],"args":[30,2,4,3,0,0.25,-0.02],"expected":{"water_c":29.99501462686545,"pending_heat_kwh":5.012932194536888,"source_depletion_kwh":4.557365230114069,"heat_kwh":3.013809806463877}},
  {"parameters":[60,1000,{"recovery_rate_per_h":0.18,"heat_loss_per_kwh":0.025},4.5],"args":[30,2,4,3,0.7,0.25,-0.02],"expected":{"water_c":29.995014748286263,"pending_heat_kwh":5.09996412486512,"source_depletion_kwh":4.57891576354524,"heat_kwh":3.100849022040871}},
  {"parameters":[60,1000,{"recovery_rate_per_h":1.4285714285714286,"heat_loss_per_kwh":0.025},4.5],"args":[30,2,4,3,-0.4,0.25,-0.02],"expected":{"water_c":29.995014625766085,"pending_heat_kwh":5.0112562354457655,"source_depletion_kwh":3.4182420036872263,"heat_kwh":3.0121337814107667}},
  {"parameters":[60,1000,{"recovery_rate_per_h":1.4285714285714286,"heat_loss_per_kwh":0.025},4.5],"args":[30,2,4,3,0,0.25,-0.02],"expected":{"water_c":29.995014696336384,"pending_heat_kwh":5.062121230031399,"source_depletion_kwh":3.4293778210127517,"heat_kwh":3.0630030102142616}},
  {"parameters":[60,1000,{"recovery_rate_per_h":1.4285714285714286,"heat_loss_per_kwh":0.025},4.5],"args":[30,2,4,3,0.7,0.25,-0.02],"expected":{"water_c":29.995014819801785,"pending_heat_kwh":5.15109642118066,"source_depletion_kwh":3.4488655013324214,"heat_kwh":3.1519856092876855}},
  {"parameters":[60,1000,{"recovery_rate_per_h":128,"heat_loss_per_kwh":0.025},4.5],"args":[30,2,4,3,-0.4,0.25,-0.02],"expected":{"water_c":29.995015238528218,"pending_heat_kwh":5.3054472185438355,"source_depletion_kwh":0.022680664062550315,"heat_kwh":3.3063615302368996}},
  {"parameters":[60,1000,{"recovery_rate_per_h":128,"heat_loss_per_kwh":0.025},4.5],"args":[30,2,4,3,0,0.25,-0.02],"expected":{"water_c":29.995015316518877,"pending_heat_kwh":5.361618392900636,"source_depletion_kwh":0.023437500000050314,"heat_kwh":3.362537384033203}},
  {"parameters":[60,1000,{"recovery_rate_per_h":128,"heat_loss_per_kwh":0.025},4.5],"args":[30,2,4,3,0.7,0.25,-0.02],"expected":{"water_c":29.995015452999088,"pending_heat_kwh":5.45991458835273,"source_depletion_kwh":0.024761962890675313,"heat_kwh":3.460841768297834}},
];

Deno.test("prepared source transitions retain every original floating-point result", () => {
  for (const {parameters, args, expected} of cases) {
    const kernel = new PoolSourceKernel(...parameters);
    assertEquals(kernel.piece(...args), expected);
    const [water, pending, depletion, power, slope, hours, cooling] = args;
    const project = kernel.preparePiece(hours, slope);
    assertEquals(project(water, pending, depletion, power, cooling), expected);
    // The prepared coefficients remain valid after other cache entries exist.
    kernel.piece(water, pending, depletion, power, slope + 1, hours + .1, cooling);
    assertEquals(project(water, pending, depletion, power, cooling), expected);
  }
});
