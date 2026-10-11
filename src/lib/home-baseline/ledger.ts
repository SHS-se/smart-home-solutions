export interface ElectricityLedger { importKwh: number; exportKwh: number; importCostSek: number; exportRevenueSek: number; costSek: number }

export const emptyElectricityLedger = (): ElectricityLedger => ({ importKwh: 0, exportKwh: 0, importCostSek: 0, exportRevenueSek: 0, costSek: 0 });

/** Preserve separately metered imports/exports and signed prices. */
export function addElectricity(ledger: ElectricityLedger, bought: number, sold: number, importPrice: number, exportPrice: number) {
  ledger.importKwh += bought; ledger.exportKwh += sold;
  ledger.importCostSek += bought * importPrice; ledger.exportRevenueSek += sold * exportPrice;
  ledger.costSek = ledger.importCostSek - ledger.exportRevenueSek;
}
