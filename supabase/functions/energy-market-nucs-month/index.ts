// Separate worker isolates prevent the two large native domains from sharing a memory budget.
import { serveMarketArchive } from "../energy-market-archive/index.ts";
if (import.meta.main) await serveMarketArchive();
