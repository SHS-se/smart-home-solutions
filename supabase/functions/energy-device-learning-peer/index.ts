import { learningExecutorHandler } from "../_shared/device-learning-serve.ts";
Deno.serve(learningExecutorHandler("energy-device-learning-peer"));
